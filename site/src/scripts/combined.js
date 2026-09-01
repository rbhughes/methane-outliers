import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Focused story: for each rolling 12-month window (identical calendar
// ends in both jurisdictions), the top 50 units per jurisdiction by
// flared+vented share of gas-equivalent production. Data comes
// pre-ranked and pre-normalized (MCF) from top_windows.json.
const DATA = document.body.dataset.dataBase;
const RAMP = ["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"];
const BREAKS = [0.001, 0.01, 0.05, 0.2];

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pctStr = (x) =>
  x >= 0.995 ? (x * 100).toFixed(0) + "%"
  : x >= 0.01 ? (x * 100).toFixed(1) + "%"
  : (x * 100).toFixed(2) + "%";

let ab = null, tx = null, ends = [], idx = 0;

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

const features = (end) => {
  const mk = (u, jur) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [u.lon, u.lat] },
    properties: { ...u, jur },
  });
  return [
    ...(ab.top[end] ?? []).map((u) => mk(u, "Alberta")),
    ...(tx.top[end] ?? []).map((u) => mk(u, "Texas")),
  ];
};

function render() {
  const end = ends[idx];
  document.getElementById("slider-label").textContent =
    `12 months ending ${end}`;
  const badge = document.getElementById("window-badge");
  badge.textContent = `top 50 per jurisdiction · window ending ${end}`;
  badge.hidden = false;

  const feats = features(end);
  // The map may still be loading its style; the source syncs on load.
  map.getSource("units")?.setData(
    { type: "FeatureCollection", features: feats });

  document.getElementById("tiles").innerHTML = [
    ["Alberta flared + vented", (ab.totals[end].fv_mcf / 1e6).toFixed(1),
     "Bcf", `${fmt(ab.totals[end].units)} facilities reporting`],
    ["Texas flared + vented", (tx.totals[end].fv_mcf / 1e6).toFixed(1),
     "Bcf", `${fmt(tx.totals[end].units)} leases reporting`],
    ["Worst unit this window",
     pctStr(Math.max(...feats.map((f) => f.properties.i))), "",
     "flared+vented / production"],
  ]
    .map(
      ([label, value, unit, sub]) => `<div class="tile">
        <div class="label">${label}</div>
        <div class="value">${value} <span class="unit">${unit}</span></div>
        <div class="label">${sub}</div></div>`,
    )
    .join("");

  const worst = feats
    .slice()
    .sort((a, b) => b.properties.i - a.properties.i)
    .slice(0, 20);
  document.querySelector("#worst tbody").innerHTML = worst
    .map((f) => {
      const p = f.properties;
      return `<tr data-x="${f.geometry.coordinates[0]}"
          data-y="${f.geometry.coordinates[1]}">
        <td><span class="fac">${p.name ?? p.id}</span>
          <span class="sub">${p.jur} &middot; ${p.operator ?? ""}</span></td>
        <td class="num">${fmt(p.fv_mcf / 1e3)}</td>
        <td class="num">${pctStr(p.i)}</td></tr>`;
    })
    .join("");
}

// Tiles, table and slider come straight from the JSON — no map needed.
const dataReady = Promise.all([
  fetch(`${DATA}/ab/top_windows.json`).then((r) => r.json()),
  fetch(`${DATA}/tx/top_windows.json`).then((r) => r.json()),
]).then(([a, t]) => {
  ab = a;
  tx = t;
  const txEnds = new Set(tx.ends);
  ends = ab.ends.filter((e) => txEnds.has(e));
  idx = ends.length - 1;
  const slider = document.getElementById("window-slider");
  slider.max = String(ends.length - 1);
  slider.value = String(idx);
  slider.addEventListener("input", () => {
    idx = +slider.value;
    render();
  });
  render();
});

map.on("load", async () => {
  map.addSource("units", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "units",
    type: "circle",
    source: "units",
    paint: {
      "circle-color": [
        "step", ["get", "i"],
        RAMP[0], BREAKS[0], RAMP[1], BREAKS[1], RAMP[2],
        BREAKS[2], RAMP[3], BREAKS[3], RAMP[4],
      ],
      "circle-radius": [
        "interpolate", ["linear"], ["sqrt", ["get", "fv_mcf"]],
        0, 3, 100, 4.5, 800, 14,
      ],
      "circle-opacity": 0.85,
      "circle-stroke-color": "#fcfcfb",
      "circle-stroke-width": 0.8,
    },
    layout: { "circle-sort-key": ["*", -1, ["get", "fv_mcf"]] },
  });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on("mousemove", "units", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(`
      <div class="pop-name">${p.name ?? p.id}</div>
      <div class="pop-sub">${p.jur} &middot; ${p.operator ?? ""} &middot;
        ${p.sub ?? ""}</div>
      <div class="pop-row"><span>Flared + vented</span>
        <span class="v">${fmt(p.fv_mcf / 1e3)} MMcf</span></div>
      <div class="pop-row"><span>Share of production</span>
        <span class="v">${pctStr(p.i)}</span></div>
    `).addTo(map);
  });
  map.on("mouseleave", "units", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });

  await dataReady;
  render();
});

document.getElementById("worst").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-x]");
  if (tr) map.flyTo({ center: [+tr.dataset.x, +tr.dataset.y], zoom: 9.5 });
});
