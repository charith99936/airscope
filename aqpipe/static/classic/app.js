"use strict";

const $ = (id) => document.getElementById(id);
const LAYER_ORDER = [
  ["pm25", "ML PM2.5"],
  ["cams_pm25", "CAMS PM2.5"],
  ["pm25_no_satellite", "ML, no satellite"],
  ["aod", "Satellite AOD"],
];
const FULL_MODEL = "LightGBM: weather + CAMS + INSAT AOD";
const FAR_KM = 150;
const SKILL_ROW = {
  pm25: FULL_MODEL,
  cams_pm25: "CAMS PM2.5 as-is (no training)",
  pm25_no_satellite: "LightGBM: weather + CAMS, no satellite",
};

const state = { key: null, layer: "pm25", onlyAod: false, layers: {}, skill: [], meta: null,
                overlay: null, stations: null, pin: null, lastClick: null };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const detail = await r.json().then((j) => j.detail).catch(() => null);
    throw Object.assign(new Error(detail || `${r.status} ${url}`), { status: r.status, detail });
  }
  return r.json();
}

function hourLabel(utc) {
  const d = new Date(utc.replace(" ", "T") + "Z");
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
                                     hour: "2-digit", minute: "2-digit", hour12: false });
}

// Same piecewise-linear ramp as the server so dots, chips and the overlay agree
function rampColor(v, stops, ramp) {
  const rgb = ramp.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const x = Math.min(Math.max(v, stops[0]), stops[stops.length - 1]);
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1]) k++;
  const t = (x - stops[k]) / (stops[k + 1] - stops[k] || 1);
  const c = rgb[k].map((a, i) => Math.round(a + (rgb[k + 1][i] - a) * t));
  return `rgb(${c.join(",")})`;
}
const pmColor = (v) => rampColor(v, state.layers.pm25.stops, state.layers.pm25.ramp);

// ---- map
// OpenStreetMap tiles, greyed in CSS so the data layer carries the colour. For anything beyond
// local use, switch to a tile provider whose terms allow your traffic.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const map = L.map("map", { minZoom: 3, maxZoom: 11, zoomSnap: 0.25, worldCopyJump: false }).setView([22.5, 80], 5);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
darkQuery.addEventListener("change", () => { if (state.key) loadStations(); });
map.createPane("stations").style.zIndex = 450;

// The pane can start at 0x0 (e.g. hidden tab); refit once it has a real size
let fitted = false;
new ResizeObserver(() => {
  map.invalidateSize();
  const size = map.getSize();
  if (!fitted && state.meta && size.x > 0 && size.y > 0) {
    map.fitBounds(state.meta.bounds, { padding: [10, 10] });
    fitted = true;
  }
}).observe($("map"));

// ---- controls
function buildControls(hours) {
  const sel = $("hour");
  sel.innerHTML = hours.map((h) => `<option value="${esc(h.key)}">${esc(hourLabel(h.hour_utc))}</option>`).join("");
  sel.addEventListener("change", () => loadHour(sel.value));

  const seg = $("layers");
  seg.innerHTML = LAYER_ORDER.filter(([k]) => state.layers[k])
    .map(([k, label]) => `<button role="radio" data-layer="${k}" aria-checked="${k === state.layer}">${label}</button>`)
    .join("");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.layer = b.dataset.layer;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
    refreshOverlay();
  });
  $("onlyAod").addEventListener("change", (e) => { state.onlyAod = e.target.checked; refreshOverlay(); });
  $("showStations").addEventListener("change", (e) => {
    if (!state.stations) return;
    e.target.checked ? state.stations.addTo(map) : state.stations.remove();
  });
  $("closeInspector").addEventListener("click", closeInspector);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInspector(); });
}

async function loadHour(key) {
  state.key = key;
  state.meta = await getJSON(`/api/meta/${key}`);
  const note = state.meta.note;
  $("banner").hidden = !note;
  $("bannerText").textContent = note;
  refreshOverlay();
  loadStations();
  if (state.lastClick) inspect(state.lastClick);
}

function refreshOverlay() {
  const url = `/api/layer/${state.key}/${state.layer}.png?only_aod=${state.onlyAod}&v=${state.meta.version}`;
  const b = state.meta.bounds;
  if (state.overlay) {
    state.overlay.setUrl(url);
    state.overlay.setBounds(L.latLngBounds(b));
  } else {
    state.overlay = L.imageOverlay(url, b, { opacity: 0.85, interactive: false }).addTo(map);
  }
  renderLegend();
}

function renderLegend() {
  const cfg = state.layers[state.layer];
  const { stops, ramp } = cfg;
  $("legendTitle").textContent = cfg.label + (cfg.unit ? ` (${cfg.unit})` : "");
  $("legendBar").innerHTML = stops.slice(0, -1)
    .map((_, k) => `<span style="background:linear-gradient(to right, ${ramp[k]}, ${ramp[k + 1]})"></span>`).join("");
  const n = stops.length - 1;
  $("legendTicks").innerHTML = stops
    .map((s, k) => `<span style="left:${(k / n) * 100}%">${k === n ? s + "+" : s}</span>`).join("");
  $("legendBands").innerHTML = cfg.naqi ? cfg.naqi.map(([, name]) => `<span>${esc(name)}</span>`).join("") : "";

  let foot = "";
  if (state.layer === "aod") {
    foot = `${Math.round(state.meta.share_cells_with_aod * 100)}% of the map has a cloud-free retrieval this hour.`;
  } else {
    const row = state.skill.find((r) => r.subset === "INSAT AOD available" && r.model === SKILL_ROW[state.layer]);
    if (row && row.r2 !== undefined) {
      foot = `At stations held out of training: R² ${row.r2.toFixed(2)} · RMSE ${row.rmse.toFixed(1)} µg/m³ (${row.n.toLocaleString()} hours)`;
    }
  }
  $("legendFoot").textContent = foot;
  $("legendFoot").hidden = !foot;
}

async function loadStations() {
  const data = await getJSON(`/api/stations/${state.key}`);
  if (state.stations) state.stations.remove();
  const ring = css("--surface");
  state.stations = L.layerGroup(
    data.stations.map((s) => {
      const has = s.observed !== null;
      const m = L.circleMarker([s.lat, s.lon], {
        pane: "stations", radius: 7, weight: 2, color: has ? ring : css("--ink-2"),
        dashArray: has ? null : "2 3", fillColor: has ? pmColor(s.observed) : ring, fillOpacity: has ? 1 : 0.6,
      });
      const pred = s.predicted !== null ? `${Math.round(s.predicted)} µg/m³` : "—";
      const obs = has ? `${Math.round(s.observed)} µg/m³` : "no valid reading this hour";
      const err = has && s.predicted !== null ? ` (${s.predicted - s.observed >= 0 ? "+" : "−"}${Math.abs(Math.round(s.predicted - s.observed))})` : "";
      m.bindTooltip(
        `<div class="station-tip"><b>${esc(s.name)}</b><br>Observed: ${obs}<br>Model at this cell: ${pred}${err}</div>`,
        { direction: "top", offset: [0, -6] });
      return m;
    }));
  if ($("showStations").checked) state.stations.addTo(map);
}

// ---- inspector
map.on("click", (e) => inspect(e.latlng));

function closeInspector() {
  $("inspector").hidden = true;
  state.lastClick = null;
  if (state.pin) { state.pin.remove(); state.pin = null; }
}

const blhNote = (m) => (m < 500 ? "low ceiling, traps pollution" : m < 1000 ? "moderate mixing" : "deep mixing, dilutes pollution");
const windNote = (w) => (w < 2 ? "stagnant" : w < 5 ? "light" : "breezy");

async function inspect(latlng) {
  state.lastClick = latlng;
  $("hint").hidden = true;
  if (state.pin) state.pin.setLatLng(latlng);
  else state.pin = L.circleMarker(latlng, { radius: 9, weight: 2, color: css("--ink"), fill: false }).addTo(map);

  const body = $("inspectorBody");
  $("inspector").hidden = false;
  let d;
  try {
    d = await getJSON(`/api/point/${state.key}?lat=${latlng.lat}&lon=${latlng.lng}`);
  } catch (err) {
    body.innerHTML = `<p class="loc">${esc(err.status === 404 ? (err.detail || "This point is outside the mapped area.") : "Could not load this point.")}</p>`;
    return;
  }
  const ns = d.nearest_station
    ? ` · ${Math.round(d.nearest_station.km)} km from the nearest station (${esc(d.nearest_station.name)})` : "";
  const fmt = (v, digits = 0, unit = "") => (v === null ? "—" : `${v.toFixed(digits)}${unit}`);

  const max = Math.max(...d.drivers.map((x) => Math.abs(x.log_effect)), 1e-6);
  const drivers = d.drivers.map((x) => {
    const w = (Math.abs(x.log_effect) / max) * 50;
    const left = x.log_effect >= 0 ? 50 : 50 - w;
    const color = x.log_effect >= 0 ? "var(--raise)" : "var(--lower)";
    const pct = `${x.pct >= 0 ? "+" : "−"}${Math.abs(Math.round(x.pct))}%`;
    return `<span class="name">${esc(x.driver)}</span>
            <span class="track"><span class="fill" style="left:${left}%;width:${w}%;background:${color}"></span></span>
            <span class="pct">${pct}</span>`;
  }).join("");
  // Lower-case only a leading capital that starts an ordinary word ("Satellite AOD" -> "satellite AOD")
  const inSentence = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
  const ups = d.drivers.filter((x) => x.pct > 0).slice(0, 2).map((x) => inSentence(x.driver));
  const downs = d.drivers.filter((x) => x.pct < 0).slice(0, 1).map((x) => inSentence(x.driver));
  const far = d.nearest_station && d.nearest_station.km > FAR_KM;
  const why = [ups.length ? `Pushed up mainly by ${ups.join(" and ")}` : "", downs.length ? `held down by ${downs[0]}` : ""]
    .filter(Boolean).join("; ");

  body.innerHTML = `
    <p class="loc">${d.cell.lat.toFixed(2)}°N, ${d.cell.lon.toFixed(2)}°E${ns}</p>
    <div class="hero"><span class="num">${fmt(d.pm25)}</span><span class="unit">µg/m³ PM2.5</span></div>
    <span class="chip"><i style="background:${pmColor(d.pm25)}"></i>${esc(d.category)}</span>
    ${far ? `<p class="caution"><span class="banner-icon" aria-hidden="true">!</span>More than ${FAR_KM} km from any
      ground station the model was trained on: treat this value as low confidence.</p>` : ""}
    <dl class="compare">
      <dt>Same model without satellite</dt><dd>${fmt(d.pm25_no_satellite, 0, " µg/m³")}</dd>
      <dt>CAMS forecast</dt><dd>${fmt(d.cams_pm25, 0, " µg/m³")}</dd>
    </dl>
    <h2>Inputs at this cell</h2>
    <dl class="compare">
      <dt>INSAT AOD (550 nm)</dt><dd>${d.aod === null ? "no retrieval (cloud / bright ground)" : d.aod.toFixed(2)}</dd>
      <dt>AOD corrected for humidity &amp; mixing</dt><dd>${fmt(d.aod_corr, 2)}</dd>
      <dt>Mixing height (BLH)</dt><dd>${d.blh === null ? "—" : `${Math.round(d.blh)} m, ${blhNote(d.blh)}`}</dd>
      <dt>Humidity</dt><dd>${fmt(d.rh, 0, "%")}</dd>
      <dt>Wind</dt><dd>${d.wind === null ? "—" : `${d.wind.toFixed(1)} m/s, ${windNote(d.wind)}`}</dd>
    </dl>
    <h2>Why this value</h2>
    <p class="why">${esc(why || "No single factor dominates.")}.</p>
    <div class="drivers">${drivers}</div>
    <p class="foot">Bars show how much each factor moved this prediction from the training average of
      ${Math.round(d.baseline_pm25)} µg/m³ (SHAP values from the model).</p>`;
}

// ---- start
(async function init() {
  const data = await getJSON("/api/hours");
  if (!data.hours.length) {
    $("hint").textContent = "No maps yet. Run: python -m aqpipe predict ...";
    return;
  }
  state.layers = data.layers;
  state.skill = data.skill;
  buildControls(data.hours);
  await loadHour(data.hours[0].key);
  const size = map.getSize();
  if (size.x > 0 && size.y > 0) {
    map.fitBounds(state.meta.bounds, { padding: [10, 10] });
    fitted = true;
  }
})();
