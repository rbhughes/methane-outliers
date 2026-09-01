import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// One map, both jurisdictions, one comparable measure:
// intensity = flared+vented / gas-equivalent production (unitless),
// each over its jurisdiction's latest 12-month window. AB volumes are
// converted to MCF (1 e3m3 = 35.3147 MCF) so dot sizes compare too.
const DATA = document.body.dataset.dataBase;
const E3M3_TO_MCF = 35.3147;
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
const BREAKS = [0.001, 0.01, 0.05, 0.2];
const MATERIAL_MCF = 2000;

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pctStr = (x) =>
  x >= 0.01 ? (x * 100).toFixed(1) + "%" : (x * 100).toFixed(2) + "%";

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  bounds: [
    [-121, 25],
    [-92, 61],
  ],
  fitBoundsOptions: { padding: 12 },
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
map.on("error", (e) => console.error("[map]", e.error ?? e));
window._map = map;

const colorExpr = [
  "step", ["get", "intensity"],
  RAMP[0], BREAKS[0], RAMP[1], BREAKS[1], RAMP[2],
  BREAKS[2], RAMP[3], BREAKS[3], RAMP[4],
];
const radiusExpr = [
  "interpolate", ["linear"], ["sqrt", ["get", "fv_mcf"]],
  0, 1.6, 100, 3, 800, 12,
];

// Normalize both jurisdictions to {name, operator, sub, fv_mcf, intensity}.
function abFeature(f) {
  const p = f.properties;
  const fv = (p.vent + p.flare) * E3M3_TO_MCF;
  const thr = p.throughput * E3M3_TO_MCF;
  if (!(thr > 0)) return null;
  return feat(f.geometry.coordinates, "Alberta", p.name, p.operator,
              p.subtype, fv, fv / thr);
}
function txFeature(f) {
  const p = f.properties;
  if (!(p.throughput > 0)) return null;
  return feat(f.geometry.coordinates, "Texas", p.name, p.operator,
              `${p.county} Co. · ${p.kind}`, p.flare_vent,
              p.flare_vent / p.throughput);
}
const feat = (coords, jur, name, operator, sub, fv, intensity) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coords },
  properties: {
    jur, name, operator, sub,
    fv_mcf: Math.round(fv),
    intensity: Math.round(intensity * 1e4) / 1e4,
  },
});

map.on("load", async () => {
  const [ab, tx] = await Promise.all([
    fetch(`${DATA}/ab/facilities.geojson`).then((r) => r.json()),
    fetch(`${DATA}/tx/leases.geojson`).then((r) => r.json()),
  ]);
  const features = [
    ...ab.features.map(abFeature),
    ...tx.features.map(txFeature),
  ].filter(Boolean);
  map.addSource("units", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });
  map.addLayer({
    id: "units",
    type: "circle",
    source: "units",
    paint: {
      "circle-color": colorExpr,
      "circle-radius": radiusExpr,
      "circle-opacity": 0.8,
    },
    layout: { "circle-sort-key": ["*", -1, ["get", "fv_mcf"]] },
  });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "units", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`
      <div class="pop-name">${p.name ?? "?"}</div>
      <div class="pop-sub">${p.jur} &middot; ${p.operator ?? ""} &middot;
        ${p.sub ?? ""}</div>
      <div class="pop-row"><span>Flared + vented</span>
        <span class="v">${fmt(p.fv_mcf / 1e3)} MMcf</span></div>
      <div class="pop-row"><span>Share of production</span>
        <span class="v">${pctStr(p.intensity)}</span></div>
    `).addTo(map);
  });
  map.on("mouseleave", "units", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });

  // Worst-intensity table: material volumes only, both jurisdictions.
  const worst = features
    .filter((f) => f.properties.fv_mcf >= MATERIAL_MCF * 10)
    .sort((a, b) => b.properties.intensity - a.properties.intensity)
    .slice(0, 20);
  document.querySelector("#worst tbody").innerHTML = worst
    .map((f) => {
      const p = f.properties;
      return `<tr data-x="${f.geometry.coordinates[0]}"
          data-y="${f.geometry.coordinates[1]}">
        <td><span class="fac">${p.name ?? "?"}</span>
          <span class="sub">${p.jur} &middot; ${p.operator ?? ""}</span></td>
        <td class="num">${fmt(p.fv_mcf / 1e3)}</td>
        <td class="num">${pctStr(p.intensity)}</td></tr>`;
    })
    .join("");
});

document.getElementById("worst").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-x]");
  if (tr) map.flyTo({ center: [+tr.dataset.x, +tr.dataset.y], zoom: 9.5 });
});

Promise.all([
  fetch(`${DATA}/ab/summary.json`).then((r) => r.json()),
  fetch(`${DATA}/tx/summary.json`).then((r) => r.json()),
]).then(([ab, tx]) => {
  const abFv = (ab.total_vent_e3m3 + ab.total_flare_e3m3) * E3M3_TO_MCF / 1e6;
  const txFv = tx.total_flare_vent_mcf / 1e6;
  document.getElementById("tiles").innerHTML = [
    ["Alberta flared + vented", abFv.toFixed(1), "Bcf",
     `${fmt(ab.facilities)} facilities`],
    ["Texas flared + vented", txFv.toFixed(1), "Bcf",
     `${fmt(tx.leases)} leases`],
    ["Alberta window", `${ab.window_first} – ${ab.window_last}`, "", ""],
    ["Texas window",
     `${tx.window_first.slice(0, 4)}-${tx.window_first.slice(4)} – ` +
     `${tx.window_last.slice(0, 4)}-${tx.window_last.slice(4)}`, "", ""],
  ]
    .map(
      ([label, value, unit, sub]) => `<div class="tile">
        <div class="label">${label}</div>
        <div class="value">${value} <span class="unit">${unit}</span></div>
        <div class="label">${sub}</div></div>`,
    )
    .join("");
});
