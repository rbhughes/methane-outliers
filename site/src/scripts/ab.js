import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const DATA = document.body.dataset.dataBase + "/ab";
const METRICS = {
  vent: { label: "Vented", top: "top_vent", total: "total_vent_e3m3" },
  flare: { label: "Flared", top: "top_flare", total: "total_flare_e3m3" },
  fuel: { label: "Fuel", top: "top_fuel", total: "total_fuel_e3m3" },
};
// Sequential blue ramp (reference palette steps 150..700).
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
const OUTLIER_PCT = 0.95;
const MATERIAL = 50;

const fmt = (n) => Number(n).toLocaleString("en-CA", { maximumFractionDigits: 0 });
let metric = "vent";
let summary = null;
let byId = new Map();

/* ---------- map ---------- */
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  bounds: [
    [-120.7, 48.8],
    [-109.3, 60.2],
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
const radiusExpr = (m) => [
  "interpolate", ["linear"], ["sqrt", ["max", ["get", m], 0]],
  0, 2.2, 7, 4, 45, 13,
];
const outlierExpr = (m) => [
  "all",
  [">=", ["get", `${m}_pct`], OUTLIER_PCT],
  [">=", ["get", m], MATERIAL],
];

map.on("load", async () => {
  const geo = await fetch(`${DATA}/facilities.geojson`).then((r) => r.json());
  for (const f of geo.features) byId.set(f.properties.id, f);
  map.addSource("facilities", { type: "geojson", data: geo });
  map.addLayer({
    id: "facilities",
    type: "circle",
    source: "facilities",
    paint: {
      "circle-color": colorExpr(metric),
      "circle-radius": radiusExpr(metric),
      "circle-opacity": 0.82,
      "circle-stroke-color": [
        "case", outlierExpr(metric), "#0b0b0b", "rgba(0,0,0,0)",
      ],
      "circle-stroke-width": 1.4,
    },
    // Draw small dots last so big peers can't bury them.
    layout: { "circle-sort-key": ["*", -1, ["get", metric]] },
  });

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: "300px",
  });
  map.on("mousemove", "facilities", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(popupHtml(p)).addTo(map);
  });
  map.on("mouseleave", "facilities", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
});

function popupHtml(p) {
  const rows = Object.entries(METRICS)
    .map(([m, cfg]) => {
      const pct = Math.round(p[`${m}_pct`] * 100);
      const strong = m === metric ? " style='font-weight:650'" : "";
      return `<div class="pop-row"${strong}><span>${cfg.label}</span>
        <span class="v">${fmt(p[m])} e3m&sup3; &middot; p${pct}</span></div>`;
    })
    .join("");
  const flag =
    p[`${metric}_pct`] >= OUTLIER_PCT && p[metric] >= MATERIAL
      ? `<div class="pop-flag">${METRICS[metric].label} outlier vs ${p.peers} peers</div>`
      : "";
  return `<div class="pop-name">${p.name ?? p.id}</div>
    <div class="pop-sub">${p.operator ?? ""} &middot; ${p.subtype ?? ""} &middot;
      ${p.wells} well${p.wells === 1 ? "" : "s"}</div>${rows}${flag}`;
}

/* ---------- tiles + table ---------- */
function renderTiles() {
  const s = summary;
  document.getElementById("tiles").innerHTML = [
    ["Facilities scored", fmt(s.facilities), ""],
    ["Vented gas", fmt(s.total_vent_e3m3), "e3m³"],
    ["Flared gas", fmt(s.total_flare_e3m3), "e3m³"],
    ["Fuel gas", fmt(s.total_fuel_e3m3), "e3m³"],
  ]
    .map(
      ([label, value, unit]) => `<div class="tile"><div class="label">${label}</div>
        <div class="value">${value} <span class="unit">${unit}</span></div></div>`,
    )
    .join("");
  const badge = document.getElementById("window-badge");
  badge.textContent = `${s.window_first} – ${s.window_last}`;
  badge.hidden = false;
  document.getElementById("attribution").textContent = s.attribution;
}

function renderTable() {
  const rows = summary[METRICS[metric].top];
  document.getElementById("panel-title").textContent =
    `Top ${METRICS[metric].label.toLowerCase()} outliers`;
  document.querySelector("#outliers tbody").innerHTML = rows
    .map((r) => {
      const ratio = r.peer_median > 0 ? (r.volume_e3m3 / r.peer_median).toFixed(0) : "—";
      return `<tr data-id="${r.facility_id}">
        <td><span class="fac">${r.name ?? r.facility_id}</span>
          <span class="sub">${r.subtype}</span></td>
        <td>${r.operator}</td>
        <td class="num">${fmt(r.volume_e3m3)}</td>
        <td class="num">${ratio}</td></tr>`;
    })
    .join("");
}

document.querySelector("#outliers tbody").closest("table").addEventListener("click", (e) => {
  const id = e.target.closest("tr[data-id]")?.dataset.id;
  const f = id && byId.get(id);
  if (f) map.flyTo({ center: f.geometry.coordinates, zoom: 10.5 });
});

for (const btn of document.querySelectorAll(".metric-toggle button")) {
  btn.addEventListener("click", () => {
    metric = btn.dataset.metric;
    for (const b of document.querySelectorAll(".metric-toggle button"))
      b.setAttribute("aria-selected", String(b === btn));
    if (map.getLayer("facilities")) {
      map.setPaintProperty("facilities", "circle-color", colorExpr(metric));
      map.setPaintProperty("facilities", "circle-radius", radiusExpr(metric));
      map.setPaintProperty("facilities", "circle-stroke-color", [
        "case", outlierExpr(metric), "#0b0b0b", "rgba(0,0,0,0)",
      ]);
      map.setLayoutProperty("facilities", "circle-sort-key",
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
  });
