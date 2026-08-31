"""Command line interface: methane build [--data DIR] [--out DIR]."""
import argparse
import os
from pathlib import Path

from . import scoring, site_data


def main() -> None:
    p = argparse.ArgumentParser(prog="methane", description=__doc__)
    p.add_argument("--province", default="AB", choices=("AB", "SK"))
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build",
                       help="score facilities and emit site artifacts")
    b.add_argument("--data",
                   default=os.environ.get("PETRINEX_OUT",
                                          "../petrinex-etl/data"),
                   help="petrinex-etl data dir holding facility_months/ "
                        "and infra/ (default: $PETRINEX_OUT)")
    b.add_argument("--out", default="data/site",
                   help="artifact output dir (default: data/site)")
    a = p.parse_args()
    if a.cmd == "build":
        data, out = Path(a.data), Path(a.out)
        if not (data / "facility_months" / a.province).exists():
            raise SystemExit(
                f"no facility_months under {data}; run petrinex "
                "build-facilities first (and build-infra)")
        run = scoring.score(data, out, a.province)
        print(f"  scored {run['facilities']:,} facilities "
              f"({run['located']:,} located), window "
              f"{run['window_first']}..{run['window_last']}")
        site = site_data.emit(out, run)
        print(f"  site data: {site['geojson_features']:,} map points, "
              f"{site['geojson_mb']} MB geojson -> {out}")


if __name__ == "__main__":
    main()
