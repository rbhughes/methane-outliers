"""Rolling-window top-outlier series for the combined map.

For every 12-month window ending each month, the top N units per
jurisdiction by flare+vent intensity (flared+vented / gas-equivalent
production), plus the jurisdiction's window total. Everything is
normalized to MCF so the site does no unit math.

Floors: a unit needs MATERIAL_MCF of flared+vented volume and
THR_FLOOR_MCF of production in the window to be ranked — without a
production floor, near-zero producers post absurd ratios and drown
the story. Windows end no earlier than each archive's first full
window and no later than its last complete month; the site uses the
intersection of the two jurisdictions' end lists, which aligns the
calendars exactly.

Units are reporting units (AB facilities, TX leases) — neither
jurisdiction publishes complete well-level vent/flare attribution.
"""
import json
from pathlib import Path

import duckdb

from petrinex_etl.dls import latlon_from_dls

E3M3_TO_MCF = 35.3147
LIQ_TO_GAS_E3M3 = 1.0687
BBL_TO_MCF = 6.0
WINDOW = 12
TOP_N = 50
MATERIAL_MCF = 2000.0
THR_FLOOR_MCF = 1000.0


def _series(con, monthly: str, ident: str) -> dict:
    """monthly: table (unit_id, month, fv_mcf, thr_mcf) with month as
    YYYY-MM; ident: table (unit_id, name, operator, sub, lat, lon)."""
    months = [m for (m,) in con.execute(
        f"select distinct month from {monthly} order by 1").fetchall()]
    ends = months[WINDOW - 1:]
    out = {"window_months": WINDOW, "ends": ends, "totals": {}, "top": {}}
    for end in ends:
        first = months[months.index(end) - WINDOW + 1]
        total, units = con.execute(f"""
            select coalesce(sum(fv_mcf), 0), count(distinct unit_id)
            from {monthly} where month between '{first}' and '{end}'
        """).fetchone()
        out["totals"][end] = {"fv_mcf": round(float(total)),
                              "units": units}
        rows = con.execute(f"""
            with w as (
              select unit_id, sum(fv_mcf) fv, sum(thr_mcf) thr
              from {monthly}
              where month between '{first}' and '{end}'
              group by 1
              having sum(fv_mcf) >= {MATERIAL_MCF}
                 and sum(thr_mcf) >= {THR_FLOOR_MCF})
            select w.unit_id, i.name, i.operator, i.sub, i.lat, i.lon,
                   round(w.fv), round(w.fv / w.thr, 4)
            from w join {ident} i using (unit_id)
            where i.lat is not null
            order by w.fv / w.thr desc limit {TOP_N}""").fetchall()
        out["top"][end] = [
            {"id": r[0], "name": r[1], "operator": r[2], "sub": r[3],
             "lat": round(r[4], 4), "lon": round(r[5], 4),
             "fv_mcf": float(r[6]), "i": float(r[7])} for r in rows]
    return out


def emit_ab(data: Path, out: Path) -> dict:
    con = duckdb.connect()
    fm = f"'{data}/facility_months/AB/*.parquet'"
    infra = f"'{data}/infra/AB_facility_infrastructure.parquet'"
    con.execute(f"""
      create table monthly as
      select facility_id unit_id, month,
        greatest(sum(case when activity in ('VENT','FLARE')
            and product='GAS' then volume end), 0) * {E3M3_TO_MCF} fv_mcf,
        (greatest(sum(case when activity='PROD' and product='GAS'
             then volume end), 0)
         + {LIQ_TO_GAS_E3M3} * greatest(sum(case when activity='PROD'
             and product in ('OIL','COND') then volume end), 0))
          * {E3M3_TO_MCF} thr_mcf
      from {fm} group by 1, 2""")
    ops = con.execute(f"""
      select facility_id, operator_name from (
        select facility_id, operator_name,
          row_number() over (partition by facility_id
                             order by month desc) rn
        from (select distinct facility_id, month, operator_name
              from {fm})) where rn = 1""").fetchall()
    op_map = dict(ops)
    rows = con.execute(f"""
      select FacilityID, FacilityName, FacilitySubTypeDesc,
        try_cast(trim(FacilityLegalSubdivision) as int),
        try_cast(trim(FacilitySection) as int),
        try_cast(trim(FacilityTownship) as int),
        try_cast(trim(FacilityRange) as int),
        try_cast(trim(FacilityMeridian) as int)
      from {infra}""").fetchall()
    ident = []
    for fid, name, sub, lsd, sec, twp, rge, mer in rows:
        try:
            lat, lon = latlon_from_dls(twp, rge, mer, sec=sec, lsd=lsd)
        except (ValueError, TypeError):
            lat = lon = None
        ident.append((fid, name, op_map.get(fid), sub, lat, lon))
    con.execute("""create table ident (unit_id varchar, name varchar,
        operator varchar, sub varchar, lat double, lon double)""")
    con.executemany("insert into ident values (?,?,?,?,?,?)", ident)
    series = _series(con, "monthly", "ident")
    (out / "top_windows.json").write_text(
        json.dumps(series, separators=(",", ":")))
    return {"ends": len(series["ends"])}


def emit_tx(data: Path, out: Path) -> dict:
    con = duckdb.connect()
    disp = f"'{data}/pdq/og_lease_cycle_disp.parquet'"
    cycle = f"'{data}/pdq/og_lease_cycle.parquet'"
    lease = f"'{data}/pdq/og_regulatory_lease_dw.parquet'"
    wells = f"'{data}/pdq/og_well_completion.parquet'"
    wloc = f"'{data}/wells/well_locations.parquet'"
    # Drop the two newest cycles (incomplete) and cap history at what
    # the site can align with Alberta anyway, plus a year of slack.
    last, = con.execute(
        f"select max(CYCLE_YEAR_MONTH) from {disp}").fetchone()
    last = str(int(last) - 2)
    con.execute(f"""
      create table monthly as
      select d.OIL_GAS_CODE || '-' || d.DISTRICT_NO || '-' || d.LEASE_NO
          as unit_id,
        substr(d.CYCLE_YEAR_MONTH, 1, 4) || '-'
          || substr(d.CYCLE_YEAR_MONTH, 5, 2) as month,
        greatest(coalesce(LEASE_GAS_DISPCD04_VOL, 0)
               + coalesce(LEASE_CSGD_DISPCDE04_VOL, 0), 0) fv_mcf,
        greatest(coalesce(c.LEASE_GAS_PROD_VOL, 0)
               + coalesce(c.LEASE_CSGD_PROD_VOL, 0), 0)
          + {BBL_TO_MCF} * greatest(coalesce(c.LEASE_OIL_PROD_VOL, 0)
               + coalesce(c.LEASE_COND_PROD_VOL, 0), 0) thr_mcf
      from {disp} d
      left join {cycle} c using (OIL_GAS_CODE, DISTRICT_NO, LEASE_NO,
                                 CYCLE_YEAR_MONTH)
      where d.CYCLE_YEAR_MONTH between '202101' and '{last}'""")
    con.execute(f"""
      create table ident as
      select r.OIL_GAS_CODE || '-' || r.DISTRICT_NO || '-' || r.LEASE_NO
          as unit_id,
        r.LEASE_NAME as name, r.OPERATOR_NAME as operator,
        coalesce(x.county, '?') || ' Co. · ' ||
          case r.OIL_GAS_CODE when 'O' then 'oil lease'
                              else 'gas lease' end as sub,
        x.lat, x.lon
      from {lease} r
      left join (
        select w.OIL_GAS_CODE, w.DISTRICT_NO, w.LEASE_NO,
          any_value(w.COUNTY_NAME) county,
          median(l.lat) lat, median(l.lon) lon
        from {wells} w
        left join {wloc} l on l.api_county = w.API_COUNTY_CODE
                          and l.api_unique = w.API_UNIQUE_NO
        group by 1, 2, 3
      ) x using (OIL_GAS_CODE, DISTRICT_NO, LEASE_NO)""")
    series = _series(con, "monthly", "ident")
    (out / "top_windows.json").write_text(
        json.dumps(series, separators=(",", ":")))
    return {"ends": len(series["ends"])}
