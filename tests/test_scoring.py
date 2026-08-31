"""Score a tiny synthetic facility_months + infra layout end to end."""
import json

import duckdb
import pytest

from methane_outliers import scoring, site_data

SUBTYPE = "GAS MULTIWELL GROUP BATTERY"


@pytest.fixture
def data(tmp_path):
    fm = tmp_path / "facility_months" / "AB"
    fm.mkdir(parents=True)
    (tmp_path / "infra").mkdir()
    con = duckdb.connect()
    rows = []
    # 12 peers: fac00 vents 100/month, the rest 1/month; all produce.
    for i in range(12):
        fid = f"ABBT{i:07d}"
        for month in ("2025-01", "2025-02"):
            vent = 100.0 if i == 0 else 1.0
            rows += [
                (month, fid, "BT", SUBTYPE, "0X99", "TESTCO", "VENT",
                 "GAS", fid, "BT", vent),
                (month, fid, "BT", SUBTYPE, "0X99", "TESTCO", "PROD",
                 "GAS", f"ABWI{i:07d}", "WI", 500.0),
            ]
    con.execute("""create table t (month varchar, facility_id varchar,
      facility_type varchar, facility_subtype varchar,
      operator_baid varchar, operator_name varchar, activity varchar,
      product varchar, from_to_id varchar, from_to_type varchar,
      volume double)""")
    con.executemany("insert into t values (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute(f"""copy (select *, 24.0 as hours, null::double as energy
      from t) to '{fm / "2025-01.parquet"}' (format parquet)""")
    con.execute("""create table i (FacilityID varchar,
      FacilityLegalSubdivision varchar, FacilitySection varchar,
      FacilityTownship varchar, FacilityRange varchar,
      FacilityMeridian varchar, FacilityName varchar,
      FacilityOperationalStatus varchar)""")
    con.executemany("insert into i values (?,?,?,?,?,?,?,?)", [
        (f"ABBT{i:07d}", "7", "19", "010", "15", "4",
         f"TEST BATTERY {i}", "ACTIVE") for i in range(12)])
    con.execute(f"""copy i to
      '{tmp_path / "infra" / "AB_facility_infrastructure.parquet"}'
      (format parquet)""")
    return tmp_path


def test_outlier_scores_high_and_peers_low(data, tmp_path):
    out = tmp_path / "site"
    run = scoring.score(data, out)
    assert run["facilities"] == 12 and run["located"] == 12
    con = duckdb.connect()
    got = dict(con.execute(f"""select facility_id, vent_pct
      from '{out / "scores.parquet"}'""").fetchall())
    assert got["ABBT0000000"] == pytest.approx(1.0)
    assert all(v < 0.5 for k, v in got.items() if k != "ABBT0000000")
    med, = con.execute(f"""select distinct vent_peer_med
      from '{out / "scores.parquet"}' where facility_id != 'ABBT0000000'
    """).fetchone()
    assert med == pytest.approx(2.0)  # 2 months x 1.0/month


def test_site_artifacts(data, tmp_path):
    out = tmp_path / "site"
    run = scoring.score(data, out)
    site = site_data.emit(out, run)
    assert site["geojson_features"] == 12
    gj = json.loads((out / "facilities.geojson").read_text())
    lon, lat = gj["features"][0]["geometry"]["coordinates"]
    assert 49 < lat < 60 and -120 < lon < -110
    sm = json.loads((out / "summary.json").read_text())
    assert sm["facilities"] == 12
    assert sm["top_vent"][0]["facility_id"] == "ABBT0000000"
    assert "Government of Alberta" in sm["attribution"]


def test_negative_amendment_sums_clamp_to_zero(tmp_path):
    fm = tmp_path / "facility_months" / "AB"
    fm.mkdir(parents=True)
    (tmp_path / "infra").mkdir()
    con = duckdb.connect()
    con.execute(f"""copy (
      select '2025-01' as month, 'ABBT0000001' facility_id, 'BT'
        facility_type, '{SUBTYPE}' facility_subtype, '0X99'
        operator_baid, 'TESTCO' operator_name, 'VENT' activity,
        'GAS' product, 'ABBT0000001' from_to_id, 'BT' from_to_type,
        -5.0 volume, 0.0 as hours, null::double as energy
    ) to '{fm / "2025-01.parquet"}' (format parquet)""")
    con.execute(f"""copy (select 'ABBT0000001' FacilityID,
      '7' FacilityLegalSubdivision, '19' FacilitySection,
      '010' FacilityTownship, '15' FacilityRange, '4' FacilityMeridian,
      'T' FacilityName, 'ACTIVE' FacilityOperationalStatus)
      to '{tmp_path / "infra" / "AB_facility_infrastructure.parquet"}'
      (format parquet)""")
    scoring.score(tmp_path, tmp_path / "site")
    vent, = duckdb.connect().execute(f"""select vent from
      '{tmp_path / "site" / "scores.parquet"}'""").fetchone()
    assert vent == 0.0
