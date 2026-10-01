#!/usr/bin/env bash
# Build the site and deploy it to Cloudflare Pages (methane.purr.io).
#
# --branch=main is load-bearing: Pages treats any other branch as a preview
# deployment, which gets its own *.pages.dev URL and leaves methane.purr.io
# pointing at whatever was last pushed to main.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="methane-outliers"

# The site reads its data from R2 at runtime; this must match what the ab/tx
# workflows publish, or a hand-run deploy points the live site at nothing.
export PUBLIC_DATA_BASE="${PUBLIC_DATA_BASE:-https://pub-45d719103a704b39a9b18888c4d12fad.r2.dev/site-data}"

npm --prefix site ci
npm --prefix site run build

# site/public/data/ is gitignored scratch from local ETL runs, and Astro
# copies public/ into dist/ wholesale. The deployed site reads its data from
# R2 at runtime and never touches these, but they are large enough that
# wrangler rejects the upload (Pages caps a file at 25 MiB). CI never sees
# this because a fresh checkout has no local data.
rm -rf site/dist/data

npx wrangler pages deploy site/dist \
  --project-name "$PROJECT" \
  --branch=main

echo "Deployed. https://methane.purr.io"
