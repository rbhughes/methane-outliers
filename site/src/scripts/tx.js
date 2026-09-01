import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DATA = document.body.dataset.dataBase + "/tx";
const METRICS = {
  flare_vent: { label: "Flared + vented", top: "top_flare_vent" },
  fuel: { label: "Lease fuel", top: "top_fuel" },
};
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
const OUTLIER_PCT = 0.95;
const MATERIAL = 2000; // MCF over the window

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
let metric = "flare_vent";
let summary = null;
let byId = new Map();

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

const colorExpr = (m) => [
  "step", ["get", `${m}_pct`],
  RAMP[0], 0.5, RAMP[1], 0.75, RAMP[2], 0.9, RAMP[3], OUTLIER_PCT, RAMP[4],
];
// sqrt scale sized for MCF magnitudes (top leases ~600,000 MCF)
const radiusExpr = (m) => [
  "interpolate", ["linear"], ["sqrt", ["max", ["get", m], 0]],
  0, 1.8, 45, 3.2, 780, 13,
];
const outlierExpr = (m) => [
  "all",
  [">=", ["get", `${m}_pct`], OUTLIER_PCT],
  [">=", ["get", m], MATERIAL],
];

map.on("load", async () => {
  const [counties, geo] = await Promise.all([
    fetch("/tx-counties.geojson").then((r) => r.json()),
    fetch(`${DATA}/leases.geojson`).then((r) => r.json()),
  ]);
  for (const f of geo.features) byId.set(f.properties.id, f);
  map.addSource("counties", { type: "geojson", data: counties });
  map.addLayer({
    id: "county-line",
    type: "line",
    source: "counties",
    paint: { "line-color": "#c3c2b7", "line-width": 0.5 },
  });
  map.addSource("leases", { type: "geojson", data: geo });
  map.addLayer({
    id: "leases",
    type: "circle",
    source: "leases",
    paint: {
      "circle-color": colorExpr(metric),
      "circle-radius": radiusExpr(metric),
      "circle-opacity": 0.82,
      "circle-stroke-color": [
        "case", outlierExpr(metric), "#0b0b0b", "rgba(0,0,0,0)",
      ],
      "circle-stroke-width": 1.2,
    },
    layout: { "circle-sort-key": ["*", -1, ["get", metric]] },
  });

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: "300px",
  });
  map.on("mousemove", "leases", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.features[0].geometry.coordinates)
      .setHTML(popupHtml(p)).addTo(map);
  });
  map.on("mouseleave", "leases", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
});

function popupHtml(p) {
  const rows = Object.entries(METRICS)
    .map(([m, cfg]) => {
      const pct = Math.round(p[`${m}_pct`] * 100);
      return `<div class="pop-row"><span>${cfg.label}</span>
        <span class="v">${fmt(p[m] / 1e3)} MMcf &middot; p${pct}</span></div>`;
    })
    .join("");
  const flag =
    p[`${metric}_pct`] >= OUTLIER_PCT && p[metric] >= MATERIAL
      ? `<div class="pop-flag">${METRICS[metric].label} outlier vs ${p.peers} peers</div>`
      : "";
  const wells = `${p.wells} well${p.wells === 1 ? "" : "s"}`;
  return `<div class="pop-name">${p.name ?? p.id}</div>
    <div class="pop-sub">${p.operator ?? ""} &middot; ${p.county ?? "?"} Co.
      &middot; ${p.kind} &middot; ${wells}</div>${rows}${flag}`;
}

function renderTiles() {
  const s = summary;
  document.getElementById("tiles").innerHTML = [
    ["Leases scored", fmt(s.leases), ""],
    ["Flared + vented", (s.total_flare_vent_mcf / 1e6).toFixed(1), "Bcf"],
    ["Lease fuel", (s.total_fuel_mcf / 1e6).toFixed(1), "Bcf"],
    ["Leases on map", fmt(s.leases_mapped), ""],
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
      return `<tr data-id="${r.lease_no}">
        <td><span class="fac">${r.name ?? r.lease_no}</span>
          <span class="sub">${r.county ?? "?"} Co. &middot; ${r.kind}</span></td>
        <td>${r.operator ?? ""}</td>
        <td class="num">${fmt(r.volume_mcf / 1e3)}</td>
        <td class="num">${ratio}</td></tr>`;
    })
    .join("");
}

document.getElementById("outliers").addEventListener("click", (e) => {
  const id = e.target.closest("tr[data-id]")?.dataset.id;
  const f = id && byId.get(id);
  if (f) map.flyTo({ center: f.geometry.coordinates, zoom: 10.5 });
});

for (const btn of document.querySelectorAll(".metric-toggle button")) {
  btn.addEventListener("click", () => {
    metric = btn.dataset.metric;
    for (const b of document.querySelectorAll(".metric-toggle button"))
      b.setAttribute("aria-selected", String(b === btn));
    if (map.getLayer("leases")) {
      map.setPaintProperty("leases", "circle-color", colorExpr(metric));
      map.setPaintProperty("leases", "circle-radius", radiusExpr(metric));
      map.setPaintProperty("leases", "circle-stroke-color", [
        "case", outlierExpr(metric), "#0b0b0b", "rgba(0,0,0,0)",
      ]);
      map.setLayoutProperty("leases", "circle-sort-key",
        ["*", -1, ["get", metric]]);
    }
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
