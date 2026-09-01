"""Texas scoring: the AB peer-expectation lens at lease grain.

Same v1 method as Alberta (see scoring.py), adapted to what RRC data
supports (see rrc-etl's README for the measured source facts):

- Grain: LEASE-month, from the PDQ dump. The reporting unit above
  wells, like Alberta's reporting facility.
- Metrics: flare_vent = gas + casinghead disposition code 04 —
  Texas bulk data never splits flared from vented, any year — and
  fuel = code 01 (lease/field fuel use). Units are MCF.
- Window: trailing 12 months ending 2 months before the newest month
  in the dump — the last two cycles are visibly incomplete (measured:
  ~114k leases in the final month vs ~133k steady state).
- Peer group: oil vs gas lease x throughput quartile, where
  throughput is gas-equivalent MCF (gas + casinghead + 6 x liquids).
  Zero-throughput leases form band 0; groups under MIN_PEERS fall
  back to the whole oil/gas class.
- Location: leases have no coordinates in the dump; each lease is
  assigned its wells' modal county (og_well_completion), and the map
  is a county choropleth. County FIPS via gp_county.
"""
from pathlib import Path

import duckdb

BBL_TO_MCF = 6.0     # rough energy equivalence for throughput banding
WINDOW_MONTHS = 12
DROP_TAIL_MONTHS = 2
MIN_PEERS = 10


def score(data: Path, out: Path) -> dict:
    """Build tx scores.parquet from rrc-etl's data/pdq parquet."""
    disp = f"'{data}/pdq/og_lease_cycle_disp.parquet'"
    lease = f"'{data}/pdq/og_regulatory_lease_dw.parquet'"
    wells = f"'{data}/pdq/og_well_completion.parquet'"
    county = f"'{data}/pdq/gp_county.parquet'"
    con = duckdb.connect()

    last_all, = con.execute(
        f"select max(CYCLE_YEAR_MONTH) from {disp}").fetchone()
    months = con.execute(f"""
        select distinct CYCLE_YEAR_MONTH from {disp}
        where CYCLE_YEAR_MONTH <= '{int(last_all) - DROP_TAIL_MONTHS}'
        order by 1 desc limit {WINDOW_MONTHS}""").fetchall()
    last = months[0][0]
    first = months[-1][0]

    cycle = f"'{data}/pdq/og_lease_cycle.parquet'"
    con.execute(f"""
    create table feat as
    with d as (
      select OIL_GAS_CODE, DISTRICT_NO, LEASE_NO,
        any_value(OPERATOR_NO) operator_no,
        count(*) months_active,
        greatest(sum(coalesce(LEASE_GAS_DISPCD04_VOL, 0)
                   + coalesce(LEASE_CSGD_DISPCDE04_VOL, 0)), 0) flare_vent,
        greatest(sum(coalesce(LEASE_GAS_DISPCD01_VOL, 0)
                   + coalesce(LEASE_CSGD_DISPCDE01_VOL, 0)), 0) fuel
      from {disp}
      where CYCLE_YEAR_MONTH between '{first}' and '{last}'
      group by 1, 2, 3),
    p as (  -- production lives in og_lease_cycle, not the disp table
      select OIL_GAS_CODE, DISTRICT_NO, LEASE_NO,
        greatest(sum(coalesce(LEASE_GAS_PROD_VOL, 0)
                   + coalesce(LEASE_CSGD_PROD_VOL, 0)), 0)
          + {BBL_TO_MCF} * greatest(sum(coalesce(LEASE_OIL_PROD_VOL, 0)
                   + coalesce(LEASE_COND_PROD_VOL, 0)), 0) throughput
      from {cycle}
      where CYCLE_YEAR_MONTH between '{first}' and '{last}'
      group by 1, 2, 3)
    select d.*, coalesce(p.throughput, 0) throughput
    from d left join p using (OIL_GAS_CODE, DISTRICT_NO, LEASE_NO)
    """)

    con.execute(f"""
    create table scored as
    with banded as (
      select *, case when throughput > 0 then ntile(4) over (
          partition by OIL_GAS_CODE, (throughput > 0)
          order by throughput) else 0 end band
      from feat),
    keyed as (
      select *, case when count(*) over (partition by OIL_GAS_CODE, band)
          >= {MIN_PEERS} then OIL_GAS_CODE || '/' || band
          else OIL_GAS_CODE end peer_key
      from banded)
    select *, count(*) over pg peer_count,
      percent_rank() over (pg order by flare_vent) flare_vent_pct,
      percent_rank() over (pg order by fuel) fuel_pct,
      median(flare_vent) over pg flare_vent_peer_med,
      median(fuel) over pg fuel_peer_med
    from keyed
    window pg as (partition by peer_key)
    """)

    # Lease identity, operator, and modal county (via well completions).
    out.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
      copy (
        select s.*, r.LEASE_NAME lease_name, r.OPERATOR_NAME operator_name,
               r.FIELD_NAME field_name, c.county_name, c.fips,
               '{first}' window_first, '{last}' window_last
        from scored s
        left join {lease} r using (OIL_GAS_CODE, DISTRICT_NO, LEASE_NO)
        left join (
          with wc as (
            select OIL_GAS_CODE, DISTRICT_NO, LEASE_NO, COUNTY_NAME,
                   count(*) n
            from {wells} group by 1, 2, 3, 4),
          modal as (
            select *, row_number() over (
              partition by OIL_GAS_CODE, DISTRICT_NO, LEASE_NO
              order by n desc) rn
            from wc)
          select m.OIL_GAS_CODE, m.DISTRICT_NO, m.LEASE_NO,
                 m.COUNTY_NAME county_name, g.COUNTY_FIPS_CODE fips
          from modal m
          left join {county} g on g.COUNTY_NAME = m.COUNTY_NAME
          where m.rn = 1
        ) c using (OIL_GAS_CODE, DISTRICT_NO, LEASE_NO)
      ) to '{out / "scores.parquet"}' (format parquet, compression zstd)
    """)
    n, located = con.execute(f"""
      select count(*), count(fips) from '{out / "scores.parquet"}'
    """).fetchone()
    return {"window_first": first, "window_last": last,
            "leases": n, "located": located}


TOP_N = 25
PCT_FLOOR = 0.95
MATERIAL_MCF = 2000.0   # over the window; ~ AB's 50 e3m3 bar


def emit(out: Path, run: dict) -> dict:
    """county_stats.json (choropleth) + summary.json (headline/tables)."""
    import json

    con = duckdb.connect()
    scores = f"'{out / 'scores.parquet'}'"

    counties = {}
    for fips, name, fv, fuel, leases, outliers in con.execute(f"""
        select fips, any_value(county_name),
          round(sum(flare_vent)), round(sum(fuel)), count(*),
          sum(case when flare_vent_pct >= {PCT_FLOOR}
                    and flare_vent >= {MATERIAL_MCF} then 1 else 0 end)
        from {scores} where fips is not null group by fips""").fetchall():
        counties[fips] = {"name": name, "flare_vent": fv, "fuel": fuel,
                          "leases": leases, "outliers": outliers}
    (out / "county_stats.json").write_text(
        json.dumps(counties, separators=(",", ":")))

    def top(metric: str) -> list[dict]:
        return [dict(zip(
            ["lease_no", "name", "operator", "county", "kind",
             "volume_mcf", "peer_median", "pct"], r)) for r in
            con.execute(f"""
              select DISTRICT_NO || '-' || LEASE_NO, lease_name,
                operator_name, county_name,
                case OIL_GAS_CODE when 'O' then 'oil lease'
                                  else 'gas lease' end,
                round({metric}), round({metric}_peer_med, 1),
                round({metric}_pct, 3)
              from {scores}
              where {metric}_pct >= {PCT_FLOOR}
                and {metric} >= {MATERIAL_MCF}
              order by {metric} desc limit {TOP_N}""").fetchall()]

    t = con.execute(f"""
      select round(sum(flare_vent)), round(sum(fuel)),
             count(*), count(fips) from {scores}""").fetchone()
    summary = {
        "window_first": run["window_first"],
        "window_last": run["window_last"],
        "leases": t[2], "located": t[3],
        "counties": len(counties),
        "total_flare_vent_mcf": t[0],
        "total_fuel_mcf": t[1],
        "top_flare_vent": top("flare_vent"),
        "top_fuel": top("fuel"),
        "note": "Texas bulk data reports flared and vented gas as one "
                "combined disposition (code 04); the split exists on "
                "Form PR since 2021 but is not published in bulk.",
        "attribution": "Source: Railroad Commission of Texas, "
                       "Production Data Query dump.",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    return {"counties": len(counties)}
