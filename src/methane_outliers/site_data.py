"""Emit the static artifacts the website consumes.

- facilities.geojson: one point per located, active-in-window facility,
  with the score properties the map styles by. Volumes rounded to 0.1
  e3m3 and percentiles to 3 places — mapping payload, not the record
  of truth (that is scores.parquet, which ships alongside it).
- summary.json: window, totals, and top-outlier lists for the site's
  headline stats, so first paint needs no parquet query.
"""
import json
from pathlib import Path

import duckdb

TOP_N = 25
# An outlier for the summary: extreme in its peer group AND material.
PCT_FLOOR = 0.95
MATERIAL_E3M3 = 50.0   # over the 12-month window


def emit(out: Path, run: dict) -> dict:
    con = duckdb.connect()
    scores = f"'{out / 'scores.parquet'}'"

    feats = []
    for r in con.execute(f"""
      select facility_id, facility_name, subtype, operator_name,
        round(lat, 5), round(lon, 5),
        round(vent, 1), round(flare, 1), round(fuel, 1),
        round(vent_pct, 3), round(flare_pct, 3), round(fuel_pct, 3),
        round(throughput, 1), n_wells, peer_count
      from {scores} where lat is not null
    """).fetchall():
        (fid, name, subtype, op, lat, lon, vent, flare, fuel,
         vent_pct, flare_pct, fuel_pct, thr, n_wells, peers) = r
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": fid, "name": name, "subtype": subtype,
                "operator": op, "vent": vent, "flare": flare,
                "fuel": fuel, "vent_pct": vent_pct,
                "flare_pct": flare_pct, "fuel_pct": fuel_pct,
                "throughput": thr, "wells": n_wells, "peers": peers,
            },
        })
    (out / "facilities.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "features": feats},
        separators=(",", ":")))

    def top(metric: str) -> list[dict]:
        return [dict(zip(
            ["facility_id", "name", "operator", "subtype",
             "volume_e3m3", "peer_median", "pct"], r)) for r in
            con.execute(f"""
              select facility_id, facility_name, operator_name, subtype,
                round({metric}, 1), round({metric}_peer_med, 1),
                round({metric}_pct, 3)
              from {scores}
              where {metric}_pct >= {PCT_FLOOR}
                and {metric} >= {MATERIAL_E3M3}
              order by {metric} desc limit {TOP_N}""").fetchall()]

    totals = con.execute(f"""
      select round(sum(vent)), round(sum(flare)), round(sum(fuel)),
             count(*), count(lat) from {scores}""").fetchone()
    summary = {
        "window_first": run["window_first"],
        "window_last": run["window_last"],
        "facilities": totals[3],
        "located": totals[4],
        "total_vent_e3m3": totals[0],
        "total_flare_e3m3": totals[1],
        "total_fuel_e3m3": totals[2],
        "top_vent": top("vent"),
        "top_flare": top("flare"),
        "top_fuel": top("fuel"),
        "attribution": "Contains information licensed from Petrinex; "
                       "data (c) Government of Alberta.",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    return {"geojson_features": len(feats),
            "geojson_mb": round(
                (out / "facilities.geojson").stat().st_size / 1e6, 1)}
