// Landing tiles: both jurisdictions' headline numbers in common units.
// 1 e3m3 = 35.3147 MCF; volumes shown as Bcf over each 12-month window.
const DATA = document.body.dataset.dataBase;
const E3M3_TO_MCF = 35.3147;
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const tile = (label, value, unit, sub) => `
  <div class="tile"><div class="label">${label}</div>
    <div class="value">${value} <span class="unit">${unit}</span></div>
    <div class="label">${sub}</div></div>`;

Promise.all([
  fetch(`${DATA}/ab/summary.json`).then((r) => r.json()),
  fetch(`${DATA}/tx/summary.json`).then((r) => r.json()),
]).then(([ab, tx]) => {
  const abFv =
    ((ab.total_vent_e3m3 + ab.total_flare_e3m3) * E3M3_TO_MCF) / 1e6;
  const txFv = tx.total_flare_vent_mcf / 1e6;
  document.getElementById("compare-tiles").innerHTML = [
    tile("Alberta flared + vented", abFv.toFixed(1), "Bcf",
         `${fmt(ab.facilities)} facilities · 12 months`),
    tile("Texas flared + vented", txFv.toFixed(1), "Bcf",
         `${fmt(tx.leases)} leases · 12 months`),
    tile("Alberta fuel gas", (ab.total_fuel_e3m3 * E3M3_TO_MCF / 1e6).toFixed(1),
         "Bcf", `window ${ab.window_first} – ${ab.window_last}`),
    tile("Texas lease fuel", (tx.total_fuel_mcf / 1e6).toFixed(1), "Bcf",
         `window ${tx.window_first.slice(0, 4)}-${tx.window_first.slice(4)}`
         + ` – ${tx.window_last.slice(0, 4)}-${tx.window_last.slice(4)}`),
  ].join("");
});
