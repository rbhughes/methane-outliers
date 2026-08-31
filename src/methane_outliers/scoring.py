"""Peer-expectation scores for vented, flared and fuel gas.

v1 model, deliberately simple and fully explainable:

- Window: the trailing 12 complete production months in facility_months.
- Per facility, summed over the window: VENT/FLARE/FUEL gas (e3m3),
  gas-equivalent throughput = PROD gas + 1.0687 * PROD liquids
  (1 m3 oil = 6.2898 bbl ~= 1.0687 e3m3 gas on energy), and the count
  of distinct wells reporting through the facility. Amendment months
  can leave small negative sums; metrics are clamped at zero.
- Peer group: facility subtype x throughput quartile (quartiles taken
  among peers with throughput > 0; zero-throughput facilities form
  band 0 of their subtype — gas plants and gathering systems report
  PROC/REC, not PROD, and must not be compared against batteries).
- Score per metric: percentile rank within the peer group, plus the
  ratio to the peer median. Percentiles need no distributional
  assumptions — most facilities vent zero, so z-scores degenerate.
  A facility only counts as an outlier when BOTH its percentile is
  high and its absolute volume is material; tiny groups (< MIN_PEERS)
  fall back to the whole subtype as the peer group.

Operator attribution is the operator of record in each facility's
latest reporting month (facility_months carries it monthly).
"""
from pathlib import Path

import duckdb

from petrinex_etl.dls import latlon_from_dls

LIQ_TO_GAS_E3M3 = 1.0687   # 1 m3 oil/cond, energy-equivalent e3m3 gas
WINDOW_MONTHS = 12
MIN_PEERS = 10


def score(data: Path, out: Path, province: str = "AB") -> dict:
    """Build scores.parquet from facility_months + infra parquet.
    Returns a small dict of run facts (window, counts)."""
    fm = f"'{data}/facility_months/{province}/*.parquet'"
    infra = f"'{data}/infra/{province}_facility_infrastructure.parquet'"
    con = duckdb.connect()

    last, = con.execute(f"select max(month) from {fm}").fetchone()
    first, = con.execute(f"""
        select min(month) from (
          select distinct month from {fm} order by month desc
          limit {WINDOW_MONTHS})""").fetchone()

    con.execute(f"""
    create table feat as
    with w as (select * from {fm} where month between '{first}' and '{last}'),
    sums as (
      select facility_id,
        any_value(facility_type) facility_type,
        any_value(facility_subtype) subtype,
        count(distinct month) months_active,
        greatest(sum(case when activity='VENT' and product='GAS'
                          then volume end), 0) vent,
        greatest(sum(case when activity='FLARE' and product='GAS'
                          then volume end), 0) flare,
        greatest(sum(case when activity='FUEL' and product='GAS'
                          then volume end), 0) fuel,
        greatest(sum(case when activity='PROD' and product='GAS'
                          then volume end), 0)
          + {LIQ_TO_GAS_E3M3} * greatest(sum(case when activity='PROD'
              and product in ('OIL','COND') then volume end), 0) throughput,
        count(distinct case when from_to_type='WI'
                            then from_to_id end) n_wells
      from w group by 1),
    op as (
      select facility_id, operator_baid, operator_name from (
        select facility_id, operator_baid, operator_name,
          row_number() over (partition by facility_id
                             order by month desc) rn
        from (select distinct facility_id, month,
                     operator_baid, operator_name from w)) where rn = 1)
    select sums.*, op.operator_baid, op.operator_name
    from sums join op using (facility_id)
    """)

    con.execute(f"""
    create table scored as
    with banded as (
      select *, case when throughput > 0 then ntile(4) over (
          partition by subtype, (throughput > 0) order by throughput)
        else 0 end band
      from feat),
    grp as (
      select *, count(*) over (partition by subtype, band) peer_n
      from banded),
    keyed as (  -- small groups fall back to the whole subtype
      select *, case when peer_n >= {MIN_PEERS}
        then subtype || '/' || band else subtype end peer_key
      from grp)
    select facility_id, facility_type, subtype, months_active, n_wells,
      operator_baid, operator_name, throughput, band, peer_key,
      count(*) over pg peer_count,
      vent, flare, fuel,
      percent_rank() over (pg order by vent)  vent_pct,
      percent_rank() over (pg order by flare) flare_pct,
      percent_rank() over (pg order by fuel)  fuel_pct,
      median(vent)  over pg vent_peer_med,
      median(flare) over pg flare_peer_med,
      median(fuel)  over pg fuel_peer_med
    from keyed
    window pg as (partition by peer_key)
    """)

    # lat/lon from the facility's DLS parts, at LSD granularity.
    rows = con.execute(f"""
      select FacilityID,
        try_cast(trim(FacilityLegalSubdivision) as int),
        try_cast(trim(FacilitySection) as int),
        try_cast(trim(FacilityTownship) as int),
        try_cast(trim(FacilityRange) as int),
        try_cast(trim(FacilityMeridian) as int),
        FacilityName, FacilityOperationalStatus
      from {infra}""").fetchall()
    locs = []
    for fid, lsd, sec, twp, rge, mer, name, status in rows:
        try:
            lat, lon = latlon_from_dls(twp, rge, mer, sec=sec, lsd=lsd)
        except (ValueError, TypeError):
            lat = lon = None
        locs.append((fid, lat, lon, name, status))
    con.execute("""create table loc (facility_id varchar, lat double,
        lon double, facility_name varchar, status varchar)""")
    con.executemany("insert into loc values (?,?,?,?,?)", locs)

    out.mkdir(parents=True, exist_ok=True)
    con.execute(f"""
      copy (
        select scored.*, loc.lat, loc.lon, loc.facility_name, loc.status,
               '{first}' window_first, '{last}' window_last
        from scored left join loc using (facility_id)
      ) to '{out / "scores.parquet"}' (format parquet, compression zstd)
    """)
    n, located = con.execute(f"""
      select count(*), count(lat) from '{out / "scores.parquet"}'
    """).fetchone()
    return {"window_first": first, "window_last": last,
            "facilities": n, "located": located}
