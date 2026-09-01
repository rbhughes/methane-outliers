# methane-outliers

Peer-expectation outlier scores for vented, flared and fuel gas —
**Alberta facilities and Texas leases**, same lens, two regulatory
regimes — live at [methane.purr.io](https://methane.purr.io). The
full pipeline: ETL on GitHub Actions (Alberta weekly, Texas monthly),
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

## The Texas model (v1)

Same method at lease grain, from the
[rrc-etl](https://github.com/rbhughes/rrc-etl) data layer: metrics
are flared+vented gas (disposition code 04 — Texas bulk data never
splits them; see rrc-etl's README) and lease fuel (code 01); peer
group = oil/gas class x gas-equivalent-throughput quartile; window =
trailing 12 months ending 2 months before the newest cycle (the last
two are visibly incomplete). Leases carry no coordinates in the dump,
so each is drawn at the median surface location of its wells (rrc-etl
`fetch-wells`, the RRC GIS layer), with its wells' modal county as
identity; leases whose wells don't match the GIS layer stay in the
tables but off the map.

## Run it

```sh
# data layers first: petrinex-etl (fetch-vol, fetch-infra,
# build-facilities, build-infra) and rrc-etl (fetch-pdq, build-pdq)
uv sync --extra tx
uv run methane build ab --data ../petrinex-etl/data
uv run methane build tx --data ../rrc-etl/data
```

Outputs land in `data/site/<jurisdiction>/`:

| artifact | purpose |
|---|---|
| `scores.parquet` | full scored table; the record of truth |
| `ab/facilities.geojson` | AB map points with score properties (~8 MB) |
| `tx/county_stats.json` | TX per-county rollup for the choropleth |
| `summary.json` | window, totals, top-outlier lists per jurisdiction |

Current scale: ~22,800 AB facilities (100% located via LSD-centroid
conversion, p50 accuracy 267 m measured against 532,623 AER ST37
surveyed wells) and ~153,000 TX leases (99.99% county-located) per
window.

## The site (`site/`)

Astro static site, MapLibre GL, OpenFreeMap Positron basemap (no key,
no tile server). Four pages: `/` (the two-regime comparison story),
`/map/` (both jurisdictions on one map, colored by the
apples-to-apples measure: flared+vented as a share of gas-equivalent
production, same window length and math on both sides), `/ab/` and
`/tx/` (per-jurisdiction dot maps — peer-percentile color, volume
size, outlier rings, tooltips, fly-to from the outlier table; TX
draws county boundaries as context). All data is fetched at runtime
from
`PUBLIC_DATA_BASE/<jurisdiction>/` (R2 in production, `/data`
locally) — data refreshes never rebuild the site.

```sh
cd site && npm install
mkdir -p public/data && cp -r ../data/site/ab ../data/site/tx public/data/
npm run dev
```

## Data licence

Petrinex data is owned by the Government of Alberta (Crown copyright;
terms at <https://petrinex.ca/terms>). This project publishes derived
statistics only, with attribution, as a non-commercial demo; raw
Petrinex files are never re-hosted (`data/` is gitignored).

## Code licence

MIT — see `LICENSE`. Code only, not the data.
