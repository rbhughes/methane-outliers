# methane-outliers

Peer-expectation outlier scores for vented, flared and fuel gas at
Alberta oil and gas facilities, from Petrinex public data — the full
pipeline for a weekly-refreshed map website: ETL on GitHub Actions,
artifacts in Cloudflare R2, an Astro + MapLibre site on Cloudflare
Pages.

The data layer is [petrinex-etl](https://github.com/rbhughes/petrinex-etl):
`facility_months` (every volumetric row at reporting-facility grain),
the business-entity tables (operator history, BA registry), and the
DLS -> lat/lon conversion. A key measured fact from building it: rows
attributed to wells carry only ~1% of FUEL volume, ~3% of FLARE and
~48% of VENT — methane accounting has to happen at facility grain.

## The model (v1)

Deliberately simple and fully explainable; every choice is in
`scoring.py`'s docstring:

- **Window:** trailing 12 complete production months.
- **Metrics:** VENT, FLARE and FUEL gas (e3m3), summed per facility.
- **Peer group:** facility subtype x throughput quartile, where
  throughput is gas-equivalent production handled (PROD gas +
  1.0687 x PROD liquids). Zero-throughput facilities (gas plants,
  gathering systems) form their own band per subtype; groups smaller
  than 10 fall back to the whole subtype.
- **Score:** percentile rank within the peer group plus ratio to the
  peer median. Most facilities vent zero, so distributional scores
  (z) degenerate; percentiles don't. A facility is only called an
  outlier when its percentile is >= 0.95 AND its volume is material
  (>= 50 e3m3 over the window).

## Run it

```sh
# data layer first (see petrinex-etl): fetch-vol, fetch-infra,
# build-facilities, build-infra
uv sync
uv run methane build --data ../petrinex-etl/data
```

Outputs land in `data/site/`:

| artifact | purpose |
|---|---|
| `scores.parquet` | full scored table; the record of truth |
| `facilities.geojson` | map points with score properties (~8 MB) |
| `summary.json` | window, totals, top-outlier lists for first paint |

Current scale: ~22,800 facilities scored per window, 100% located via
LSD-centroid conversion (p50 accuracy 267 m, measured against 532,623
AER ST37 surveyed wells).

## The site (`site/`)

Astro static site, MapLibre GL map, OpenFreeMap Positron basemap (no
key, no tile server). Facilities are colored by peer percentile on a
sequential ramp, sized by volume, outliers ringed; hover for per-metric
tooltips, click a top-outlier row to fly to it. The site fetches
`facilities.geojson` and `summary.json` at runtime from
`PUBLIC_DATA_BASE` (R2 in production, `/data` locally) — so a weekly
data refresh never rebuilds the site.

```sh
cd site && npm install
mkdir -p public/data && cp ../data/site/*.{geojson,json} public/data/
npm run dev
```

## Data licence

Petrinex data is owned by the Government of Alberta (Crown copyright;
terms at <https://petrinex.ca/terms>). This project publishes derived
statistics only, with attribution, as a non-commercial demo; raw
Petrinex files are never re-hosted (`data/` is gitignored).

## Code licence

MIT — see `LICENSE`. Code only, not the data.
