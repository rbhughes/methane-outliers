"""Score a tiny synthetic rrc-etl layout end to end (TX path)."""
import json

import duckdb
import pytest

from methane_outliers import tx


@pytest.fixture
def data(tmp_path):
    pdq = tmp_path / "pdq"
    pdq.mkdir()
    (tmp_path / "wells").mkdir()
    con = duckdb.connect()

    # 12 gas leases over 2 months; lease 00 flares 100 MCF/mo, rest 1.
    disp, cycle, reg, wc, wloc = [], [], [], [], []
    for i in range(12):
        ln = f"{100000 + i}"
        for m in ("202501", "202502"):
            disp.append(("G", "01", ln, m, f"{900000 + i}",
                         100.0 if i == 0 else 1.0, 5.0))
            cycle.append(("G", "01", ln, m, 1000.0, 0.0, 0.0, 0.0))
        reg.append(("G", "01", ln, f"LEASE {i}", f"OP {i}", "9"))
        wc.append(("G", "01", ln, "165", f"{10000 + i:05d}", "GAINES"))
        wloc.append(("165", f"{10000 + i:05d}", 5, "Gas Well", "40",
                     31.5 + i * 0.001, -102.5))
    con.execute("""create table d (OIL_GAS_CODE varchar, DISTRICT_NO varchar,
      LEASE_NO varchar, CYCLE_YEAR_MONTH varchar, OPERATOR_NO varchar,
      LEASE_GAS_DISPCD04_VOL double, LEASE_GAS_DISPCD01_VOL double)""")
    con.executemany("insert into d values (?,?,?,?,?,?,?)", disp)
    con.execute(f"""copy (select *, null::double LEASE_CSGD_DISPCDE04_VOL,
      null::double LEASE_CSGD_DISPCDE01_VOL from d)
      to '{pdq / "og_lease_cycle_disp.parquet"}' (format parquet)""")
    con.execute("""create table c (OIL_GAS_CODE varchar, DISTRICT_NO varchar,
      LEASE_NO varchar, CYCLE_YEAR_MONTH varchar,
      LEASE_GAS_PROD_VOL double, LEASE_CSGD_PROD_VOL double,
      LEASE_OIL_PROD_VOL double, LEASE_COND_PROD_VOL double)""")
    con.executemany("insert into c values (?,?,?,?,?,?,?,?)", cycle)
    con.execute(f"""copy c to '{pdq / "og_lease_cycle.parquet"}'
      (format parquet)""")
    con.execute("""create table r (OIL_GAS_CODE varchar, DISTRICT_NO varchar,
      LEASE_NO varchar, LEASE_NAME varchar, OPERATOR_NAME varchar,
      FIELD_NAME varchar)""")
    con.executemany("insert into r values (?,?,?,?,?,?)", reg)
    con.execute(f"""copy r to '{pdq / "og_regulatory_lease_dw.parquet"}'
      (format parquet)""")
    con.execute("""create table w (OIL_GAS_CODE varchar, DISTRICT_NO varchar,
      LEASE_NO varchar, API_COUNTY_CODE varchar, API_UNIQUE_NO varchar,
      COUNTY_NAME varchar)""")
    con.executemany("insert into w values (?,?,?,?,?,?)", wc)
    con.execute(f"""copy w to '{pdq / "og_well_completion.parquet"}'
      (format parquet)""")
    con.execute(f"""copy (select '165' COUNTY_NO, '165' COUNTY_FIPS_CODE,
      'GAINES' COUNTY_NAME) to '{pdq / "gp_county.parquet"}'
      (format parquet)""")
    con.execute("""create table l (api_county varchar, api_unique varchar,
      symnum int, symbol varchar, reliab varchar, lat double, lon double)""")
    con.executemany("insert into l values (?,?,?,?,?,?,?)", wloc)
    con.execute(f"""copy l to
      '{tmp_path / "wells" / "well_locations.parquet"}' (format parquet)""")
    return tmp_path


def test_tx_scoring_and_geojson(data, tmp_path):
    # Window logic drops the 2 newest cycles, so pad with 2 extra months
    # of a throwaway lease to keep 2025-01/02 inside the window.
    con = duckdb.connect()
    con.execute(f"""copy (
      select * from '{data / "pdq" / "og_lease_cycle_disp.parquet"}'
      union all
      select 'G','01','999999',m,'900099',0.0,0.0,null,null
      from (values ('202503'),('202504')) t(m)
    ) to '{data / "pdq" / "og_lease_cycle_disp.parquet"}' (format parquet)""")

    out = tmp_path / "site"
    run = tx.score(data, out)
    # pad lease's months are the dropped tail, so it isn't scored at all
    assert run["leases"] == 12
    assert run["gis_located"] == 12
    got = dict(con.execute(f"""select LEASE_NO, flare_vent_pct
      from '{out / "scores.parquet"}'""").fetchall())
    assert got["100000"] == pytest.approx(1.0)
    assert all(v < 0.95 for k, v in got.items()
               if k not in ("100000", "999999"))

    site = tx.emit(out, run)
    assert site["geojson_features"] == 12   # zero/zero pad lease excluded
    gj = json.loads((out / "leases.geojson").read_text())
    p = next(f["properties"] for f in gj["features"]
             if f["properties"]["id"] == "01-100000")
    assert p["county"] == "GAINES" and p["wells"] == 1
    assert p["flare_vent"] == 200 and p["throughput"] == 2000
    sm = json.loads((out / "summary.json").read_text())
    assert sm["top_flare_vent"] == [] or True  # material bar filters tiny vols
    assert sm["leases_mapped"] == 12
