import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// One page, two maps: per jurisdiction, the top 50 units by
// flared+vented share of gas-equivalent production for the selected
// 12-month window (shared slider; both archives' common window ends).
// The full unit cloud is default-off behind a toggle and lazy-loaded;
// it reflects each jurisdiction's latest scoring window.
const DATA = document.body.dataset.dataBase;
const E3M3_TO_MCF = 35.3147;
// Sequential red-orange (OrRd), light -> dark on the light basemap.
const RAMP = ["#fdd49e", "#fc8d59", "#ef6548", "#d7301f", "#990000"];
const BREAKS = [0.001, 0.01, 0.05, 0.2];

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pctStr = (x) =>
  x >= 0.995 ? (x * 100).toFixed(0) + "%"
  : x >= 0.01 ? (x * 100).toFixed(1) + "%"
  : (x * 100).toFixed(2) + "%";

const colorExpr = [
  "step", ["get", "i"],
  RAMP[0], BREAKS[0], RAMP[1], BREAKS[1], RAMP[2],
  BREAKS[2], RAMP[3], BREAKS[3], RAMP[4],
];

const JURS = {
  ab: {
    label: "facilities",
    bounds: [[-120.5, 48.8], [-109.5, 60.2]],
    windowsUrl: `${DATA}/ab/top_windows.json`,
    bulkUrl: `${DATA}/ab/facilities.geojson`,
    bulkFeature(f) {
      const p = f.properties;
      const fv = (p.vent + p.flare) * E3M3_TO_MCF;
      const thr = p.throughput * E3M3_TO_MCF;
      return bulkFeat(f, p.name, p.operator, p.subtype, fv,
                      thr > 0 ? fv / thr : 0);
    },
  },
  tx: {
    label: "leases",
    bounds: [[-107.2, 25.6], [-93.3, 36.7]],
    windowsUrl: `${DATA}/tx/top_windows.json`,
    bulkUrl: `${DATA}/tx/leases.geojson`,
    bulkFeature(f) {
      const p = f.properties;
      return bulkFeat(f, p.name, p.operator,
        `${p.county} Co. · ${p.kind}`, p.flare_vent,
        p.throughput > 0 ? p.flare_vent / p.throughput : 0);
    },
  },
};
const bulkFeat = (f, name, operator, sub, fv, i) => ({
  type: "Feature",
  geometry: f.geometry,
  properties: {
    name, operator, sub,
    fv_mcf: Math.round(fv),
    i: Math.round(i * 1e4) / 1e4,
  },
});

let ends = [];
let idx = 0;

function popupHtml(p, jurLabel) {
  return `<div class="pop-name">${p.name ?? "?"}</div>
    <div class="pop-sub">${p.operator ?? ""} &middot; ${p.sub ?? jurLabel}</div>
    <div class="pop-row"><span>Flared + vented</span>
      <span class="v">${fmt(p.fv_mcf / 1e3)} MMcf</span></div>
    <div class="pop-row"><span>Share of production</span>
      <span class="v">${pctStr(p.i)}</span></div>`;
}

for (const [jur, cfg] of Object.entries(JURS)) {
  cfg.map = new maplibregl.Map({
    container: `${jur}-map`,
    style: "https://tiles.openfreemap.org/styles/positron",
    bounds: cfg.bounds,
    fitBoundsOptions: { padding: 14 },
    attributionControl: { compact: true },
  });
  cfg.map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  cfg.map.on("error", (e) => console.error(`[${jur}]`, e.error ?? e));
  cfg.mapReady = new Promise((res) => cfg.map.on("load", res));
}

function render() {
  const end = ends[idx];
  document.getElementById("slider-label").textContent =
    `12 months ending ${end}`;

  for (const [jur, cfg] of Object.entries(JURS)) {
    const top = cfg.windows.top[end] ?? [];
    const feats = top.map((u) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [u.lon, u.lat] },
      properties: u,
    }));
    cfg.map.getSource("top")?.setData(
      { type: "FeatureCollection", features: feats });
    const t = cfg.windows.totals[end];
    document.getElementById(`${jur}-head`).innerHTML =
      `${jur === "ab" ? "Alberta" : "Texas"}
       <span class="muted">${fmt(t.units)} ${cfg.label} ·
       ${(t.fv_mcf / 1e6).toFixed(1)} Bcf flared+vented</span>`;
    document.querySelector(`#${jur}-list tbody`).innerHTML = top
      .slice(0, 15)
      .map((u) => `<tr data-x="${u.lon}" data-y="${u.lat}">
        <td><span class="fac">${u.name ?? u.id}</span>
          <span class="sub">${u.operator ?? ""}</span></td>
        <td class="num">${fmt(u.fv_mcf / 1e3)}</td>
        <td class="num">${pctStr(u.i)}</td></tr>`)
      .join("");
  }
}

const dataReady = Promise.all(
  Object.values(JURS).map((c) =>
    fetch(c.windowsUrl).then((r) => r.json()).then((w) => (c.windows = w))),
).then(() => {
  const txEnds = new Set(JURS.tx.windows.ends);
  ends = JURS.ab.windows.ends.filter((e) => txEnds.has(e));
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

for (const [jur, cfg] of Object.entries(JURS)) {
  cfg.mapReady.then(async () => {
    cfg.map.addSource("top", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    cfg.map.addLayer({
      id: "top",
      type: "circle",
      source: "top",
      paint: {
        "circle-color": colorExpr,
        "circle-radius": [
          "interpolate", ["linear"], ["sqrt", ["get", "fv_mcf"]],
          0, 3.2, 100, 4.5, 800, 13,
        ],
        "circle-opacity": 0.88,
        "circle-stroke-color": "#0b0b0b",
        "circle-stroke-width": 1.1,
      },
      layout: { "circle-sort-key": ["*", -1, ["get", "fv_mcf"]] },
    });
    cfg.map.addSource("search", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    cfg.map.addLayer({
      id: "search",
      type: "circle",
      source: "search",
      paint: {
        "circle-color": colorExpr,
        "circle-radius": [
          "interpolate", ["linear"], ["sqrt", ["get", "fv_mcf"]],
          0, 4, 100, 5, 800, 13,
        ],
        "circle-opacity": 0.9,
        "circle-stroke-color": "#0b0b0b",
        "circle-stroke-width": 1.1,
      },
    });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    for (const layer of ["top", "bulk", "search"]) {
      cfg.map.on("mousemove", layer, (e) => {
        cfg.map.getCanvas().style.cursor = "pointer";
        const f = e.features[0];
        popup.setLngLat(f.geometry.coordinates)
          .setHTML(popupHtml(f.properties, cfg.label)).addTo(cfg.map);
      });
      cfg.map.on("mouseleave", layer, () => {
        cfg.map.getCanvas().style.cursor = "";
        popup.remove();
      });
    }
    await dataReady;
    render();
  });

  document.getElementById(`${jur}-list`).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-x]");
    if (tr)
      cfg.map.flyTo({ center: [+tr.dataset.x, +tr.dataset.y], zoom: 9.5 });
  });
}

// Full unit clouds, lazy-loaded once per jurisdiction and shared by
// the "show all" toggle and the search boxes.
function ensureBulk(cfg) {
  cfg.bulkReady ??= fetch(cfg.bulkUrl)
    .then((r) => r.json())
    .then((geo) => {
      cfg.bulkFeatures = geo.features.map(cfg.bulkFeature);
    });
  return cfg.bulkReady;
}

document.getElementById("show-all").addEventListener("change", async (e) => {
  const on = e.target.checked;
  for (const cfg of Object.values(JURS)) {
    await cfg.mapReady;
    if (on && !cfg.map.getSource("bulk")) {
      await ensureBulk(cfg);
      cfg.map.addSource("bulk", {
        type: "geojson",
        data: { type: "FeatureCollection", features: cfg.bulkFeatures },
      });
      cfg.map.addLayer({
        id: "bulk",
        type: "circle",
        source: "bulk",
        paint: {
          "circle-color": colorExpr,
          "circle-radius": [
            "interpolate", ["linear"], ["sqrt", ["get", "fv_mcf"]],
            0, 1.4, 100, 2.2, 800, 7,
          ],
          "circle-opacity": 0.45,
        },
      }, "top");
    } else if (cfg.map.getLayer("bulk")) {
      cfg.map.setLayoutProperty("bulk", "visibility",
        on ? "visible" : "none");
    }
  }
});

// Per-map search over ALL units (name or operator, case-insensitive).
// Matches replace the top-50 layer until the box is cleared.
for (const [jur, cfg] of Object.entries(JURS)) {
  const input = document.getElementById(`${jur}-search`);
  const count = document.getElementById(`${jur}-count`);
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim().toLowerCase();
      await cfg.mapReady;
      if (q.length < 2) {
        cfg.map.getSource("search")?.setData(
          { type: "FeatureCollection", features: [] });
        cfg.map.getLayer("top") &&
          cfg.map.setLayoutProperty("top", "visibility", "visible");
        count.textContent = "";
        return;
      }
      count.textContent = "searching…";
      await ensureBulk(cfg);
      const matches = cfg.bulkFeatures.filter((f) => {
        const p = f.properties;
        return (p.name ?? "").toLowerCase().includes(q)
            || (p.operator ?? "").toLowerCase().includes(q);
      });
      cfg.map.getSource("search")?.setData(
        { type: "FeatureCollection", features: matches });
      cfg.map.getLayer("top") &&
        cfg.map.setLayoutProperty("top", "visibility", "none");
      count.textContent = `${fmt(matches.length)} match${
        matches.length === 1 ? "" : "es"}`;
      if (matches.length) {
        let minX = 180, minY = 90, maxX = -180, maxY = -90;
        for (const f of matches) {
          const [x, y] = f.geometry.coordinates;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        cfg.map.fitBounds([[minX, minY], [maxX, maxY]],
          { padding: 60, maxZoom: 9 });
      }
    }, 300);
  });
}
