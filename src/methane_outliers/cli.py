"""Command line interface: methane build [ab|tx] [--data DIR] [--out DIR]."""
import argparse
import os
from pathlib import Path

from . import scoring, site_data, tx


def main() -> None:
    p = argparse.ArgumentParser(prog="methane", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build",
                       help="score a jurisdiction and emit site artifacts")
    b.add_argument("jurisdiction", nargs="?", default="ab",
                   choices=("ab", "tx"))
    b.add_argument("--data",
                   help="data dir (default: $PETRINEX_OUT / ../petrinex-etl"
                        "/data for ab, $RRC_OUT / ../rrc-etl/data for tx)")
    b.add_argument("--out", help="output dir (default: data/site/<jur>)")
    a = p.parse_args()
    if a.cmd == "build":
        if a.jurisdiction == "ab":
            data = Path(a.data or os.environ.get("PETRINEX_OUT",
                                                 "../petrinex-etl/data"))
            out = Path(a.out or "data/site/ab")
            if not (data / "facility_months" / "AB").exists():
                raise SystemExit(f"no facility_months under {data}; run "
                                 "petrinex build-facilities first")
            run = scoring.score(data, out, "AB")
            print(f"  ab: scored {run['facilities']:,} facilities "
                  f"({run['located']:,} located), "
                  f"{run['window_first']}..{run['window_last']}")
            site = site_data.emit(out, run)
            print(f"  ab: {site['geojson_features']:,} map points, "
                  f"{site['geojson_mb']} MB geojson -> {out}")
        else:
            data = Path(a.data or os.environ.get("RRC_OUT",
                                                 "../rrc-etl/data"))
            out = Path(a.out or "data/site/tx")
            if not (data / "pdq").exists():
                raise SystemExit(f"no pdq parquet under {data}; run "
                                 "rrc build-pdq first")
            run = tx.score(data, out)
            print(f"  tx: scored {run['leases']:,} leases "
                  f"({run['located']:,} with county), "
                  f"{run['window_first']}..{run['window_last']}")
            site = tx.emit(out, run)
            print(f"  tx: {site['counties']} counties -> {out}")


if __name__ == "__main__":
    main()
