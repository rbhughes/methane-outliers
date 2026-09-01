import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DATA = document.body.dataset.dataBase + "/tx";
const METRICS = {
  flare_vent: { label: "Flared + vented", top: "top_flare_vent" },
  fuel: { label: "Lease fuel", top: "top_fuel" },
};
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
// County totals, MCF: <0.1 Bcf, 0.5, 2, 8, 8+
const BREAKS = [1e5, 5e5, 2e6, 8e6];

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
let metric = "flare_vent";
let summary = null;
let stats = null;
let countyBounds = new Map();

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  bounds: [
    [-107.2, 25.6],
    [-93.3, 36.7],
  ],
  fitBoundsOptions: { padding: 20 },
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
map.on("error", (e) => console.error("[map]", e.error ?? e));
window._map = map;

const fillExpr = (m) => [
  "step", ["coalesce", ["get", m], 0],
  RAMP[0], BREAKS[0], RAMP[1], BREAKS[1], RAMP[2],
  BREAKS[2], RAMP[3], BREAKS[3], RAMP[4],
];

map.on("load", async () => {
  const [geo, st] = await Promise.all([
    fetch("/tx-counties.geojson").then((r) => r.json()),
    fetch(`${DATA}/county_stats.json`).then((r) => r.json()),
  ]);
  stats = st;
  for (const f of geo.features) {
    const s = st[f.properties.fips];
    f.properties.flare_vent = s?.flare_vent ?? 0;
    f.properties.fuel = s?.fuel ?? 0;
    f.properties.leases = s?.leases ?? 0;
    f.properties.outliers = s?.outliers ?? 0;
    // bbox per county for table-row zoom
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    const scan = (c) => {
      if (typeof c[0] === "number") {
        minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
        minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
      } else c.forEach(scan);
    };
    scan(f.geometry.coordinates);
    countyBounds.set(f.properties.name, [[minX, minY], [maxX, maxY]]);
  }
  map.addSource("counties", { type: "geojson", data: geo });
  map.addLayer({
    id: "county-fill",
    type: "fill",
    source: "counties",
    paint: { "fill-color": fillExpr(metric), "fill-opacity": 0.78 },
  });
  map.addLayer({
    id: "county-line",
    type: "line",
    source: "counties",
    paint: { "line-color": "#fcfcfb", "line-width": 0.6 },
  });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "county-fill", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat).setHTML(`
      <div class="pop-name">${p.name} County</div>
      <div class="pop-sub">${fmt(p.leases)} leases &middot;
        ${fmt(p.outliers)} outliers</div>
      <div class="pop-row"><span>Flared + vented</span>
        <span class="v">${(p.flare_vent / 1e6).toFixed(2)} Bcf</span></div>
      <div class="pop-row"><span>Lease fuel</span>
        <span class="v">${(p.fuel / 1e6).toFixed(2)} Bcf</span></div>
    `).addTo(map);
  });
  map.on("mouseleave", "county-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
});

function renderTiles() {
  const s = summary;
  document.getElementById("tiles").innerHTML = [
    ["Leases scored", fmt(s.leases), ""],
    ["Flared + vented", (s.total_flare_vent_mcf / 1e6).toFixed(1), "Bcf"],
    ["Lease fuel", (s.total_fuel_mcf / 1e6).toFixed(1), "Bcf"],
    ["Counties with activity", fmt(s.counties), ""],
  ]
    .map(
      ([label, value, unit]) => `<div class="tile"><div class="label">${label}</div>
        <div class="value">${value} <span class="unit">${unit}</span></div></div>`,
    )
    .join("");
  const badge = document.getElementById("window-badge");
  const f = s.window_first, l = s.window_last;
  badge.textContent =
    `${f.slice(0, 4)}-${f.slice(4)} – ${l.slice(0, 4)}-${l.slice(4)}`;
  badge.hidden = false;
}

function renderTable() {
  const rows = summary[METRICS[metric].top];
  document.getElementById("panel-title").textContent =
    `Top ${METRICS[metric].label.toLowerCase()} leases`;
  document.querySelector("#outliers tbody").innerHTML = rows
    .map((r) => {
      const ratio = r.peer_median > 0
        ? (r.volume_mcf / r.peer_median).toFixed(0) : "—";
      return `<tr data-id="${r.county ?? ""}">
        <td><span class="fac">${r.name ?? r.lease_no}</span>
          <span class="sub">${r.county ?? "?"} Co. &middot; ${r.kind}</span></td>
        <td>${r.operator ?? ""}</td>
        <td class="num">${fmt(r.volume_mcf / 1e3)}</td>
        <td class="num">${ratio}</td></tr>`;
    })
    .join("");
}

document.getElementById("outliers").addEventListener("click", (e) => {
  const county = e.target.closest("tr[data-id]")?.dataset.id;
  const b = county && countyBounds.get(county);
  if (b) map.fitBounds(b, { padding: 60 });
});

for (const btn of document.querySelectorAll(".metric-toggle button")) {
  btn.addEventListener("click", () => {
    metric = btn.dataset.metric;
    for (const b of document.querySelectorAll(".metric-toggle button"))
      b.setAttribute("aria-selected", String(b === btn));
    if (map.getLayer("county-fill"))
      map.setPaintProperty("county-fill", "fill-color", fillExpr(metric));
    renderTable();
  });
}

fetch(`${DATA}/summary.json`)
  .then((r) => r.json())
  .then((s) => {
    summary = s;
    renderTiles();
    renderTable();
    document.getElementById("attribution").textContent =
      s.attribution + " " + s.note;
  });
