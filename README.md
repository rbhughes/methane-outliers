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

## Why Texas refreshes get refused

When the Texas numbers are stale, it is because the refresh was
actively blocked, not because the pipeline broke. The RRC publishes
the dump on schedule and the code parses it correctly; the portal
simply will not talk to the address the job runs from.

`mft.rrc.texas.gov`, the GoAnywhere portal serving the PDQ dump, sits
behind a WAF that refuses callers two ways. Both were measured here
on 2026-10-03:

- A request carrying a non-browser User-Agent gets `HTTP 403` with a
  zero-length body. `rrc-etl` sends a `Mozilla/5.0` UA, so this is
  not what bites in CI — it is just how the WAF announced itself.
- A source address the WAF has decided against gets no answer to the
  TLS handshake at all: `ssl.SSLEOFError:
  UNEXPECTED_EOF_WHILE_READING`, raised before any HTTP request is
  sent. Nothing about the request matters, because nothing about it
  is ever read.

The second one is what fails the `tx` workflow. GitHub-hosted runners
draw egress addresses from shared Azure ranges, so reachability is a
property of whichever address a run happens to get.

The record so far, which is too small to call a rate:

| run | outcome |
|---|---|
| 2026-09-01 | clean address, completed in 11m45s |
| 2026-10-01 (scheduled) | HTTP 200 whose body did not parse |
| 2026-10-03 (dispatch) | handshake dropped on the first GET |
| 2026-10-03 (dispatch) | four attempts over 7 min, all refused |

Two controls rule out the obvious alternatives: the same fetch from a
residential address succeeded on 10 of 10 attempts, and three fresh
runners that were *not* blocked parsed the page fine. The page is
unchanged — the file row is still `fileTable:0:j_id_2f` and the
listing still shows `PDQ_DSV.zip`.

`rrc-etl`'s `fetch.py` retries with minutes of backoff and names the
failure, so a blocked run reports being refused instead of blaming a
page change. That makes the failure legible, not rare: retries cannot
re-roll a runner's address, and the one run that retried had every
attempt over seven minutes refused. When a scheduled run fails this
way, re-dispatch it until one lands on a clean address, or fetch the
dump off-CI, stage it at `$RRC_RAW/PDQ_DSV.zip` and skip the fetch
step.

Alberta's weekly pipeline is unaffected; Petrinex does not do this.
Revisiting the arrangement in November 2026 — a self-hosted runner or
staging the dump in R2 would both remove the coin flip.

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
