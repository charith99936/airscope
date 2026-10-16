"use strict";
/* INSAT PM2.5 — minimal map. MapLibre (land outline) + deck.gl H3 hexagons over the FastAPI backend. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const H3_RES = 5;          // ~250 km² hexagons: about two 0.1° map cells each
const FAR_KM = 150;        // beyond this from any training station, flag low confidence
const INDIA = [[67, 6.5], [98, 37.5]];
const FULL_MODEL = "LightGBM: weather + CAMS + INSAT AOD";

// ---- colour: the data is the only colour on the page (ramps checked for monotone lightness)
const NAQI = [[0, "Good"], [30, "Satisfactory"], [60, "Moderate"], [90, "Poor"], [120, "Very poor"], [250, "Severe"]];
const PM_STOPS = [0, 30, 60, 90, 120, 250, 400];
const PM_RAMP = ["#fde3d3", "#f9b996", "#f28c5c", "#eb6834", "#c84f1f", "#9c3a14", "#6e260b"];
const AOD_STOPS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];
const CORR_STOPS = [0, 0.25, 0.5, 1, 1.5, 2, 3];
const BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const DIV_STOPS = [-60, -30, -10, 0, 10, 30, 60];
const DIV_LIGHT = ["#104281", "#3987e5", "#b7d3f6", "#f0efec", "#f4c2c1", "#e34948", "#8f2121"];
const DIV_DARK = ["#86b6ef", "#3987e5", "#1c5cab", "#2a2b30", "#a83a3a", "#e34948", "#f4a3a2"];

// CPCB National AQI health statements
const HEALTH = {
  Good: "Minimal impact.",
  Satisfactory: "Minor breathing discomfort to sensitive people.",
  Moderate: "Breathing discomfort to people with lung disease such as asthma, and to people with heart disease.",
  Poor: "Breathing discomfort to most people on prolonged exposure.",
  "Very poor": "Respiratory illness on prolonged exposure.",
  Severe: "Affects healthy people and seriously impacts those with existing diseases.",
};
const REGIONS = [
  { name: "All India", bounds: INDIA },
  { name: "Delhi NCR", bounds: [[76.8, 28.2], [77.6, 28.95]] },
  { name: "Indo-Gangetic Plain", bounds: [[73.5, 23.5], [89, 32]] },
  { name: "Mumbai", bounds: [[72.75, 18.88], [73.15, 19.3]] },
  { name: "Kolkata", bounds: [[88.2, 22.4], [88.55, 22.75]] },
  { name: "Chennai", bounds: [[80.1, 12.9], [80.35, 13.25]] },
  { name: "Bengaluru", bounds: [[77.45, 12.8], [77.75, 13.1]] },
];
const STEPS = [
  { id: "aod", label: "Satellite", caption: "What the satellite sees: haze in the whole air column. Gaps are clouds or bright desert.",
    legend: { title: "Aerosol optical depth", stops: AOD_STOPS, ramp: () => BLUE_RAMP, last: "2+" }, value: (d) => d.aod, extrude: false },
  { id: "aod_corr", label: "Corrected", caption: "The same haze corrected for mixing height and humidity, closer to what you breathe.",
    legend: { title: "Corrected AOD", stops: CORR_STOPS, ramp: () => BLUE_RAMP, last: "3+" }, value: (d) => d.aod_corr, extrude: false },
  { id: "pm25", label: "PM2.5", caption: "Street-level PM2.5 from the satellite model. Click anywhere for details.",
    legend: { title: "PM2.5 µg/m³", stops: PM_STOPS, ramp: () => PM_RAMP, last: "400+" }, value: (d) => d.pm25, extrude: true },
  { id: "cams_pm25", label: "CAMS", caption: "The CAMS forecast, with no INSAT input, on the same scale.",
    legend: { title: "CAMS PM2.5 µg/m³", stops: PM_STOPS, ramp: () => PM_RAMP, last: "400+" }, value: (d) => d.cams, extrude: true },
  { id: "gain", label: "Δ INSAT", caption: "What the satellite changed. Red: it says the air is dirtier than weather and CAMS alone.",
    legend: { title: "Change µg/m³", stops: DIV_STOPS, ramp: () => (isDark() ? DIV_DARK : DIV_LIGHT), last: "+60", first: "−60" },
    value: (d) => d.pm25 - d.nosat, extrude: false },
];

const state = {
  hours: [], i: 0, step: "pm25", is3D: innerWidth >= 768, skill: [], // phones start flat: clearer on a small screen
  data: new Map(), hexes: [], stations: [], meta: null, playTimer: null, pin: null, lastClick: null,
};
let mapInstance = null;

// ---- helpers
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const detail = await r.json().then((j) => j.detail).catch(() => null);
    throw Object.assign(new Error(detail || `${r.status} ${url}`), { status: r.status, detail });
  }
  return r.json();
}
const hexToRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function rampPos(v, stops) {
  const x = Math.min(Math.max(v, stops[0]), stops[stops.length - 1]);
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1]) k++;
  return [k, (x - stops[k]) / (stops[k + 1] - stops[k] || 1)];
}
function rampRGB(v, stops, ramp) {
  const [k, t] = rampPos(v, stops);
  const a = hexToRGB(ramp[k]), b = hexToRGB(ramp[k + 1]);
  return a.map((c, i) => Math.round(c + (b[i] - c) * t));
}
const pmRGB = (v) => rampRGB(v, PM_STOPS, PM_RAMP);
const rgb = (c) => `rgb(${c.join(",")})`;
const naqi = (v) => NAQI.reduce((label, [lo, name]) => (v >= lo ? name : label), NAQI[0][1]);
const isDark = () => document.documentElement.dataset.theme !== "light";
const currentStep = () => STEPS.find((s) => s.id === state.step);
const fmt = (v, d = 0, unit = "") => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* blocked */ } },
};
const toDate = (utc) => new Date(utc.replace(" ", "T") + "Z");
const dateLabel = (utc) => toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const clockLabel = (utc) => toDate(utc).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
const shortLabel = (utc) => `${toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}, ${clockLabel(utc)}`;
const cleanName = (n) => String(n).split(" - ")[0].trim();

function announce(text) { const l = $("live"); l.textContent = ""; requestAnimationFrame(() => { l.textContent = text; }); }
function setLoading(on) { $("progress").hidden = !on; }
let toastTimer = null;
function toast(message, ms = 6000) {
  $("toastText").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms);
}

// ---- theme
function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  $("themeBtn").setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  $("themeBtn").querySelector("use").setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
  if (persist) storage.set("atlas-theme", theme);
  // (window.map is the <div id="map"> element, so track the MapLibre instance explicitly)
  if (mapInstance && mapInstance.getLayer("land")) {
    mapInstance.setPaintProperty("sea", "background-color", css("--bg"));
    mapInstance.setPaintProperty("land", "fill-color", css("--land"));
    mapInstance.setPaintProperty("coast", "line-color", css("--coast"));
    mapInstance.setPaintProperty("india", "fill-color", css("--india"));
    mapInstance.setPaintProperty("india-line", "line-color", css("--india-line"));
  }
  if (state.hexes.length) { renderLegend(); render(); }
}
applyTheme(storage.get("atlas-theme") || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"), false);

// ---- map: a quiet land silhouette, no labels or borders — the data carries the page
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      land: { type: "geojson", data: "/static/vendor/land-world-110m.geojson", attribution: "Natural Earth" },
      india: { type: "geojson", data: "/static/vendor/india.geojson" }, // India's own point-of-view boundary
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": css("--bg") } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": css("--land") } },
      { id: "coast", type: "line", source: "land", paint: { "line-color": css("--coast"), "line-width": 0.8 } },
      { id: "india", type: "fill", source: "india", paint: { "fill-color": css("--india") } },
      { id: "india-line", type: "line", source: "india", paint: { "line-color": css("--india-line"), "line-width": 1 } },
    ],
  },
  center: [81, 22], zoom: 3.9, pitch: 38, bearing: -6, minZoom: 2.4, maxZoom: 10.5, maxPitch: 60,
  maxBounds: [[45, -12], [115, 48]], attributionControl: { compact: true },
});
mapInstance = map;
const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip, onHover: markLegend });
map.addControl(overlay);

function viewPadding() {
  const dock = document.querySelector(".dock-wrap").getBoundingClientRect();
  if (innerWidth < 768) {
    const hero = document.querySelector(".corner-left").getBoundingClientRect();
    return { top: hero.bottom + 8, bottom: innerHeight - dock.top + 8, left: 12, right: 12 };
  }
  return { top: 70, bottom: innerHeight - dock.top + 24, left: innerWidth > 1200 ? 300 : 200, right: 60 };
}
const moveOpts = (ms) => ({ duration: REDUCED ? 0 : ms });
function fitBounds(bounds, ms = 1400) {
  map.fitBounds(bounds, { padding: viewPadding(), pitch: state.is3D ? 38 : 0, bearing: state.is3D ? -6 : 0, ...moveOpts(ms) });
}

// ---- data
function aggregate(c) {
  const acc = new Map();
  for (let k = 0; k < c.idx.length; k++) {
    if (c.pm25[k] < 0) continue;
    const i = Math.floor(c.idx[k] / c.nlon), j = c.idx[k] - i * c.nlon;
    const h = h3.latLngToCell(c.lat0 + i * c.step, c.lon0 + j * c.step, H3_RES);
    let a = acc.get(h);
    if (!a) { a = { h, n: 0, pm: 0, nosat: 0, cams: 0, camsN: 0, aod: 0, aodN: 0, corr: 0, corrN: 0 }; acc.set(h, a); }
    a.n++; a.pm += c.pm25[k]; a.nosat += c.pm25_no_satellite[k];
    if (c.cams_pm25[k] >= 0) { a.cams += c.cams_pm25[k]; a.camsN++; }
    if (c.aod[k] >= 0) { a.aod += c.aod[k]; a.aodN++; }
    if (c.aod_corr[k] >= 0) { a.corr += c.aod_corr[k]; a.corrN++; }
  }
  return Array.from(acc.values(), (a) => ({
    h: a.h, n: a.n, pm25: a.pm / a.n, nosat: a.nosat / a.n, cams: a.camsN ? a.cams / a.camsN : null,
    aod: a.aodN ? a.aod / a.aodN / 100 : null, aod_corr: a.corrN ? a.corr / a.corrN / 100 : null, coverage: a.aodN / a.n,
  }));
}
function landStats(c) {
  const pm = c.pm25.filter((v) => v >= 0);
  const sorted = Float64Array.from(pm).sort();
  return {
    n: pm.length, median: sorted[Math.floor(sorted.length / 2)],
    counts: NAQI.map(([lo], k) => pm.filter((v) => v >= lo && (k === NAQI.length - 1 || v < NAQI[k + 1][0])).length),
    poor: pm.filter((v) => v >= 90).length / pm.length,
    coverage: c.aod.filter((v) => v >= 0).length / c.aod.length,
  };
}
async function loadHourData(key) {
  if (!state.data.has(key)) {
    const [cells, st, meta] = await Promise.all([getJSON(`/api/cells/${key}`), getJSON(`/api/stations/${key}`), getJSON(`/api/meta/${key}`)]);
    state.data.set(key, { hexes: aggregate(cells), stations: st.stations, meta, stats: landStats(cells) });
  }
  return state.data.get(key);
}

// ---- layers
function fillFor(step, d) {
  const v = step.value(d);
  if (v === null || !Number.isFinite(v)) return [0, 0, 0, 0];
  return [...rampRGB(v, step.legend.stops, step.legend.ramp()), 235];
}
// ~1.5 km of column per µg/m³ at national zoom, flattening as you zoom in
const elevationScale = () => Math.min(2.5, Math.max(0.03, 1.5 * 2 ** (4 - map.getZoom())));
function cityLabels() {
  const z = map.getZoom();
  if (z < 4.6) return [];
  return places.cities.filter((c) => z >= 5.6 || c.n >= 3 || places.cities.length <= 60);
}
function render() {
  const step = currentStep();
  const extrude = state.is3D && step.extrude;
  const ink = hexToRGB(css("--ink"));
  const bg = hexToRGB(css("--bg"));
  const obs = (d) => (d.observed !== null ? pmRGB(d.observed) : [120, 120, 128]);
  const noDepth = { depthCompare: "always" };
  overlay.setProps({
    layers: [
      new deck.H3HexagonLayer({
        id: "hex", data: state.hexes, getHexagon: (d) => d.h,
        filled: true, stroked: false, coverage: 0.9, extruded: extrude, elevationScale: elevationScale(),
        getElevation: (d) => Math.max(0, step.value(d) || 0) * 1000,
        getFillColor: (d) => fillFor(step, d),
        material: extrude ? { ambient: 0.62, diffuse: 0.45, shininess: 20, specularColor: [40, 40, 40] } : false,
        pickable: true, autoHighlight: true, highlightColor: [...ink, 200],
        updateTriggers: { getFillColor: [state.step, isDark()], getElevation: [state.step] },
      }),
      new deck.ScatterplotLayer({
        id: "st-glow", data: state.stations, getPosition: (d) => [d.lon, d.lat], radiusUnits: "pixels", getRadius: 9,
        getFillColor: (d) => [...obs(d), d.observed !== null ? 60 : 0], parameters: noDepth,
        updateTriggers: { getFillColor: [state.i] },
      }),
      new deck.ScatterplotLayer({
        id: "st-core", data: state.stations, getPosition: (d) => [d.lon, d.lat], radiusUnits: "pixels", getRadius: 3.5,
        stroked: true, lineWidthUnits: "pixels", getLineWidth: 1.5,
        getFillColor: (d) => [...obs(d), 255], getLineColor: [...bg, 255],
        pickable: true, parameters: noDepth, updateTriggers: { getFillColor: [state.i], getLineColor: [isDark()] },
      }),
      new deck.TextLayer({
        id: "labels", data: cityLabels(), getPosition: (d) => [d.lon, d.lat], getText: (d) => d.name,
        getSize: 11.5, sizeUnits: "pixels", getPixelOffset: [0, -16], getColor: [...ink, 190],
        fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500, characterSet: "auto",
        fontSettings: { sdf: true }, outlineWidth: 3, outlineColor: [...bg, 230], parameters: noDepth,
        updateTriggers: { getColor: [isDark()], outlineColor: [isDark()] },
      }),
    ],
  });
}
map.on("zoomend", () => { if (state.hexes.length) render(); });

function getTooltip({ object, layer }) {
  if (!object || !layer) return null;
  if (layer.id === "st-core") {
    const o = object.observed !== null ? `${Math.round(object.observed)} µg/m³` : "no reading";
    return { className: "atlas-tip", html: `${esc(cleanName(object.name))}<br><span class="t-num">${o}</span> <span class="t-sub">observed</span>` };
  }
  if (layer.id !== "hex") return null;
  const step = currentStep();
  const v = step.value(object);
  if (v === null || !Number.isFinite(v)) return { className: "atlas-tip", html: `<span class="t-sub">No satellite view here (cloud or bright ground)</span>` };
  const html = step.id.startsWith("aod")
    ? `<span class="t-num">${v.toFixed(2)}</span> <span class="t-sub">${step.legend.title.toLowerCase()}</span>`
    : step.id === "gain"
      ? `<span class="t-num">${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v))} µg/m³</span> <span class="t-sub">from adding INSAT</span>`
      : `<span class="t-num">${Math.round(v)} µg/m³</span> <span class="t-sub">${naqi(v)}</span>`;
  return { className: "atlas-tip", html };
}
function markLegend({ object, layer }) {
  const marker = $("legendMarker");
  const step = currentStep();
  const v = object && layer && layer.id === "hex" ? step.value(object) : null;
  if (v === null || !Number.isFinite(v)) { marker.hidden = true; return; }
  const [k, t] = rampPos(v, step.legend.stops);
  marker.style.left = `${((k + t) / (step.legend.stops.length - 1)) * 100}%`;
  marker.hidden = false;
}

// ---- layer switcher, legend, headline
function buildLayers() {
  const box = $("layers");
  box.innerHTML = STEPS.map((s, k) => `<button type="button" role="radio" data-step="${s.id}" aria-checked="${s.id === state.step}"
    tabindex="${s.id === state.step ? 0 : -1}" aria-keyshortcuts="${k + 1}">${esc(s.label)}</button>`).join("");
  box.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) selectStep(b.dataset.step); });
  box.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault(); e.stopPropagation();
    const k = (STEPS.findIndex((s) => s.id === state.step) + keys[e.key] + STEPS.length) % STEPS.length;
    selectStep(STEPS[k].id, true);
  });
}
function selectStep(id, focus = false) {
  if (!STEPS.some((s) => s.id === id)) return;
  state.step = id;
  $("layers").querySelectorAll("button").forEach((b) => {
    const on = b.dataset.step === id;
    b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1;
    if (on) { b.scrollIntoView({ block: "nearest", inline: "nearest" }); if (focus) b.focus(); }
  });
  $("caption").textContent = currentStep().caption;
  renderLegend();
  if (state.hexes.length) render();
  writeHash();
}
function renderLegend() {
  const { title, stops, ramp, last, first } = currentStep().legend;
  const r = ramp();
  $("legendTitle").textContent = title;
  $("legendBar").innerHTML = stops.slice(0, -1).map((_, k) => `<span style="background:linear-gradient(90deg, ${r[k]}, ${r[k + 1]})"></span>`).join("");
  const n = stops.length - 1;
  $("legendTicks").innerHTML = stops.map((s, k) => {
    const label = k === n ? last : k === 0 && first ? first : (s > 0 && first ? `+${s}` : String(s).replace("-", "−"));
    return `<span style="left:${(k / n) * 100}%">${label}</span>`;
  }).join("");
  $("legendMarker").hidden = true;
}
function renderHero() {
  const h = state.hours[state.i];
  const cur = state.data.get(h.key).stats;
  $("heroValue").textContent = Math.round(cur.median);
  $("heroCat").textContent = naqi(cur.median);
  $("heroTime").textContent = `${dateLabel(h.hour_utc)} · ${clockLabel(h.hour_utc)} IST`;
  const bandColor = (k) => rgb(pmRGB((PM_STOPS[k] + PM_STOPS[k + 1]) / 2));
  const pct = (n) => Math.round((n / cur.n) * 100);
  $("distBar").innerHTML = cur.counts.map((n, k) => (n ? `<span style="flex-grow:${n};background:${bandColor(k)}" title="${NAQI[k][1]} ${pct(n)}%"></span>` : "")).join("");
  $("distBar").setAttribute("aria-label", `Share of land by air-quality category: ${NAQI.map(([, name], k) => `${name} ${pct(cur.counts[k])}%`).join(", ")}`);
  const prevHour = state.i > 0 ? state.hours[state.i - 1] : null;
  const prev = prevHour && state.data.get(prevHour.key);
  let delta = "";
  if (prev) {
    const d = Math.round(cur.median - prev.stats.median);
    delta = d === 0 ? ` · <span class="delta">steady since ${clockLabel(prevHour.hour_utc)}</span>`
      : ` · <span class="${d > 0 ? "worse" : "better"}">${d > 0 ? "up" : "down"} ${Math.abs(d)}</span> <span class="delta">since ${clockLabel(prevHour.hour_utc)}</span>`;
  }
  $("heroMeta").innerHTML = `${Math.round(cur.poor * 100)}% of land Poor or worse${delta}`;
}

// ---- time
async function goTo(i, { announceIt = false } = {}) {
  state.i = (i + state.hours.length) % state.hours.length;
  const h = state.hours[state.i];
  $("timeSlider").value = state.i;
  $("timeSlider").setAttribute("aria-valuetext", `${dateLabel(h.hour_utc)} ${clockLabel(h.hour_utc)} IST`);
  $("timeLabel").textContent = innerWidth < 500 ? clockLabel(h.hour_utc) : shortLabel(h.hour_utc); // phones: date is in the headline
  if (!state.data.has(h.key)) setLoading(true);
  let d;
  try {
    d = await loadHourData(h.key);
  } catch (err) {
    setLoading(false);
    toast(`Could not load ${shortLabel(h.hour_utc)}: ${err.message}`);
    return;
  }
  if (state.hours[state.i].key !== h.key) return;
  setLoading(false);
  Object.assign(state, { hexes: d.hexes, stations: d.stations, meta: d.meta });
  $("demoTag").hidden = !d.meta.note;
  $("demoNote").textContent = d.meta.note || "";
  buildPlaces(d.stations);
  render(); renderHero();
  writeHash();
  if (announceIt && !state.playTimer) announce(`${shortLabel(h.hour_utc)}. Median PM2.5 ${Math.round(d.stats.median)}, ${naqi(d.stats.median)}.`);
  if (state.lastClick) inspect(state.lastClick);
  [state.hours[(state.i + 1) % state.hours.length], state.i > 0 ? state.hours[state.i - 1] : null].filter(Boolean).forEach((x) => {
    if (!state.data.has(x.key)) loadHourData(x.key).then(() => { if (state.hours[state.i].key === h.key) renderHero(); }).catch(() => {});
  });
}
function setPlaying(on) {
  clearInterval(state.playTimer);
  state.playTimer = on ? setInterval(() => goTo(state.i + 1), 2400) : null;
  $("playBtn").setAttribute("aria-pressed", on);
  $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play through hours");
  const use = $("playBtn").querySelector("use");
  use.setAttribute("href", on ? "#i-pause" : "#i-play");
  $("playBtn").querySelector("svg").classList.toggle("fill", !on);
}
function toggle3D(on = !state.is3D) {
  state.is3D = on;
  $("viewToggle").setAttribute("aria-pressed", on);
  map.easeTo({ pitch: on ? 38 : 0, bearing: on ? -6 : 0, ...moveOpts(700) });
  if (state.hexes.length) render();
  writeHash();
}

// ---- shareable URL: #h=hour&s=layer&v=3d&map=lat,lng,zoom,pitch,bearing&at=lat,lng
let hashTimer = null, restoring = true;
function writeHash(now = false) {
  if (restoring || !state.hours.length) return;
  clearTimeout(hashTimer);
  const write = () => {
    const c = map.getCenter();
    const parts = [`h=${state.hours[state.i].key}`, `s=${state.step}`, `v=${state.is3D ? "3d" : "2d"}`,
      `map=${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(2)},${Math.round(map.getPitch())},${Math.round(map.getBearing())}`];
    if (state.lastClick) parts.push(`at=${state.lastClick.lat.toFixed(3)},${state.lastClick.lng.toFixed(3)}`);
    history.replaceState(null, "", `#${parts.join("&")}`);
  };
  if (now) write(); else hashTimer = setTimeout(write, 300);
}
function readHash() {
  const out = {};
  location.hash.slice(1).split("&").filter(Boolean).forEach((kv) => { const [k, v] = kv.split("="); out[k] = decodeURIComponent(v || ""); });
  const nums = (s, n) => { const a = (s || "").split(",").map(Number); return a.length >= n && a.every(Number.isFinite) ? a : null; };
  return { hour: out.h, step: out.s, view: out.v, map: nums(out.map, 3), at: nums(out.at, 2) };
}
map.on("moveend", () => writeHash());
window.addEventListener("hashchange", () => location.reload()); // a pasted link applies like a fresh visit

// ---- search palette
const places = { cities: [], stations: [] };
const search = { items: [], active: -1 };
function buildPlaces(stations) {
  const byCity = new Map();
  places.stations = stations.map((s) => {
    const label = cleanName(s.name);
    const parts = label.split(",").map((x) => x.trim()).filter(Boolean);
    const city = parts[parts.length - 1] || label;
    const c = byCity.get(city) || { name: city, lat: 0, lon: 0, n: 0 };
    c.lat += s.lat; c.lon += s.lon; c.n += 1;
    byCity.set(city, c);
    return { kind: "station", name: label, sub: city !== label ? city : "Station", lat: s.lat, lon: s.lon };
  });
  places.cities = [...byCity.values()].map((c) => ({ kind: "city", name: c.name, lat: c.lat / c.n, lon: c.lon / c.n, n: c.n,
    sub: `${c.n} station${c.n > 1 ? "s" : ""}` }));
}
function findPlaces(query) {
  const t = query.trim().toLowerCase();
  const rank = (name) => {
    const n = name.toLowerCase();
    if (n.startsWith(t)) return 0;
    if (n.split(/[\s,()./-]+/).some((w) => w.startsWith(t))) return 1;
    return n.includes(t) ? 2 : 9;
  };
  const pick = (list, max) => list.map((p) => [rank(p.name), p]).filter(([r]) => r < 9)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, max).map(([, p]) => p);
  const cities = pick(places.cities, 4);
  const cityNames = new Set(cities.map((c) => c.name.toLowerCase()));
  const regions = REGIONS.map((r) => ({ ...r, kind: "region", sub: "Region" }));
  return [...pick(regions, 2), ...cities, ...pick(places.stations.filter((p) => !cityNames.has(p.name.toLowerCase())), 6)].slice(0, 9);
}
function renderSearch() {
  const q = $("searchInput").value.trim();
  search.items = q ? findPlaces(q) : REGIONS.map((r) => ({ ...r, kind: "region", sub: "Region" }));
  search.active = search.items.length ? 0 : -1;
  const icon = { region: "i-region", city: "i-pin", station: "i-dot" };
  $("searchList").innerHTML = (q ? "" : `<li class="group" role="presentation">Popular places</li>`) + (search.items.map((p, k) => `
    <li id="place-${k}" role="option" class="option" aria-selected="${k === search.active}" data-k="${k}">
      <svg class="ico" aria-hidden="true"><use href="#${icon[p.kind]}"/></svg>
      <span class="opt-name">${esc(p.name)}</span><span class="opt-sub">${esc(p.sub)}</span></li>`).join("") ||
    `<li class="empty" role="presentation">Nothing matches “${esc(q)}”. Try a nearby city, or click the map.</li>`);
  $("searchInput").setAttribute("aria-activedescendant", search.active >= 0 ? `place-${search.active}` : "");
}
function moveActive(delta) {
  if (!search.items.length) return;
  search.active = (search.active + delta + search.items.length) % search.items.length;
  $("searchList").querySelectorAll(".option").forEach((li) => {
    const on = Number(li.dataset.k) === search.active;
    li.setAttribute("aria-selected", on);
    if (on) li.scrollIntoView({ block: "nearest" });
  });
  $("searchInput").setAttribute("aria-activedescendant", `place-${search.active}`);
}
function openSearch() {
  $("searchInput").value = "";
  renderSearch();
  $("palette").showModal();
  $("searchInput").focus();
}
function choosePlace(p) {
  if (!p) return;
  $("palette").close();
  if (p.kind === "region") { fitBounds(p.bounds); announce(`Showing ${p.name}`); return; }
  map.flyTo({ center: [p.lon, p.lat], zoom: p.kind === "city" ? 8.4 : 9.4, pitch: state.is3D ? 45 : 0, ...moveOpts(1600) });
  inspect({ lat: p.lat, lng: p.lon });
  announce(`Showing ${p.name}`);
}
function wireSearch() {
  const input = $("searchInput");
  input.addEventListener("input", renderSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter") { e.preventDefault(); choosePlace(search.items[search.active]); }
  });
  $("searchList").addEventListener("click", (e) => {
    const li = e.target.closest(".option");
    if (li) choosePlace(search.items[Number(li.dataset.k)]);
  });
  $("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); }); // click outside
}

// ---- location sheet
const blhNote = (m) => (m < 500 ? "low ceiling, traps pollution" : m < 1000 ? "moderate mixing" : "deep mixing, dilutes");
const windNote = (w) => (w < 2 ? "stagnant" : w < 5 ? "light" : "breezy");
function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  state.lastClick = null;
  if (state.pin) { state.pin.remove(); state.pin = null; }
  writeHash();
}
async function inspect(lngLat) {
  state.lastClick = { lat: lngLat.lat, lng: lngLat.lng };
  if (!state.pin) {
    const el = document.createElement("div");
    el.className = "pin";
    state.pin = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  } else state.pin.setLngLat(lngLat);
  writeHash();
  const body = $("sheetBody");
  $("sheet").hidden = false;
  body.setAttribute("aria-busy", "true");
  let d;
  try {
    d = await getJSON(`/api/point/${state.hours[state.i].key}?lat=${lngLat.lat}&lon=${lngLat.lng}`);
  } catch (err) {
    body.innerHTML = `<p class="place">${esc(err.status === 404 ? err.detail || "Outside the mapped area." : "Could not load this spot.")}</p>`;
    body.setAttribute("aria-busy", "false");
    return;
  }
  const ns = d.nearest_station;
  const where = ns && ns.km <= 25 ? cleanName(ns.name) : `${d.cell.lat.toFixed(2)}°N, ${d.cell.lon.toFixed(2)}°E`;
  const rows = [
    { label: "Satellite model", v: d.pm25, me: true },
    { label: "Without satellite", v: d.pm25_no_satellite },
    { label: "CAMS forecast", v: d.cams_pm25 },
  ];
  if (ns && ns.km <= 25 && ns.observed !== null && ns.observed !== undefined) rows.push({ label: "Observed nearby", v: ns.observed });
  const max = Math.max(...rows.map((r) => r.v || 0), 1) * 1.05;
  const cmp = rows.map((r) => `<span class="lbl${r.me ? " me" : ""}">${r.label}</span>
    <span class="track"><span class="fill${r.me ? " me" : ""}" style="width:${((r.v || 0) / max) * 100}%"></span></span>
    <span class="v">${fmt(r.v)}</span>`).join("");
  const top = Math.max(...d.drivers.map((x) => Math.abs(x.log_effect)), 1e-6);
  const drivers = d.drivers.map((x) => {
    const w = (Math.abs(x.log_effect) / top) * 50;
    return `<span>${esc(x.driver)}</span><span class="track"><span class="fill" style="left:${x.log_effect >= 0 ? 50 : 50 - w}%;width:${w}%;background:${x.log_effect >= 0 ? "var(--up)" : "var(--down)"}"></span></span>
      <span class="v">${x.pct >= 0 ? "+" : "−"}${Math.abs(Math.round(x.pct))}%</span>`;
  }).join("");
  const lower = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
  const ups = d.drivers.filter((x) => x.pct > 0).slice(0, 2).map((x) => lower(x.driver));
  const downs = d.drivers.filter((x) => x.pct < 0).slice(0, 1).map((x) => lower(x.driver));
  const why = [ups.length ? `Mostly ${ups.join(" and ")}` : "", downs.length ? `offset by ${downs[0]}` : ""].filter(Boolean).join(", ");

  body.innerHTML = `
    <p class="place">${esc(where)}</p>
    <div class="big"><span class="num">${fmt(d.pm25)}</span><span class="unit">µg/m³</span></div>
    <p class="cat"><i style="background:${rgb(pmRGB(d.pm25))}"></i>${esc(d.category)}</p>
    <p class="health">${esc(HEALTH[d.category] || "")}</p>
    ${ns && ns.km > FAR_KM ? `<p class="warn"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg>${Math.round(ns.km)} km from the nearest station — low confidence.</p>` : ""}
    <hr class="rule">
    <div class="cmp">${cmp}</div>
    <hr class="rule">
    <p class="why">${esc(why || "No single factor dominates")}.</p>
    <details><summary>What drives this value</summary>
      <div class="drivers">${drivers}</div>
      <p class="foot">Change from the training average of ${Math.round(d.baseline_pm25)} µg/m³ (SHAP).</p>
    </details>
    <details><summary>Inputs here</summary>
      <dl class="inputs">
        <dt>Satellite AOD</dt><dd>${d.aod === null ? "not seen" : d.aod.toFixed(2)}</dd>
        <dt>Corrected AOD</dt><dd>${fmt(d.aod_corr, 2)}</dd>
        <dt>Mixing height</dt><dd>${d.blh === null ? "—" : `${Math.round(d.blh)} m · ${blhNote(d.blh)}`}</dd>
        <dt>Humidity</dt><dd>${fmt(d.rh, 0, "%")}</dd>
        <dt>Wind</dt><dd>${d.wind === null ? "—" : `${d.wind.toFixed(1)} m/s · ${windNote(d.wind)}`}</dd>
      </dl>
    </details>
    <button class="text-btn" type="button" data-action="copy-link"><svg class="ico" aria-hidden="true"><use href="#i-link"/></svg><span>Copy link</span></button>
    <p class="foot">AQI categories use 24-hour averages; this is a one-hour estimate.</p>`;
  body.setAttribute("aria-busy", "false");
}
async function copyLink(btn) {
  writeHash(true);
  const label = btn.querySelector("span");
  try { await navigator.clipboard.writeText(location.href); label.textContent = "Copied"; announce("Link copied"); }
  catch (_) { label.textContent = "Copy from the address bar"; }
  setTimeout(() => { label.textContent = "Copy link"; }, 2000);
}

// ---- dialogs
function openInfo() {
  const row = state.skill.find((r) => r.subset === "INSAT AOD available" && r.model === FULL_MODEL && r.r2 !== undefined);
  $("skillText").textContent = row
    ? `At stations in whole areas held out of training: R² ${row.r2.toFixed(2)}, typical miss ${row.mae.toFixed(0)} µg/m³. ${state.stations.filter((s) => s.observed !== null).length} stations reported this hour.`
    : "Measured at stations in whole areas held out of training.";
  $("infoDialog").showModal();
}
function openTable() {
  const rows = state.stations
    .map((s) => ({ ...s, miss: s.observed !== null && s.predicted !== null ? s.predicted - s.observed : null }))
    .sort((a, b) => (b.miss === null) - (a.miss === null) || Math.abs(b.miss || 0) - Math.abs(a.miss || 0));
  $("stationTable").querySelector("tbody").innerHTML = rows.map((s) => `<tr><td>${esc(cleanName(s.name))}</td>
    <td class="num">${fmt(s.observed)}</td><td class="num">${fmt(s.predicted)}</td>
    <td class="num">${s.miss === null ? "—" : `${s.miss >= 0 ? "+" : "−"}${Math.abs(Math.round(s.miss))}`}</td></tr>`).join("");
  $("tableTitle").textContent = `Stations · ${shortLabel(state.hours[state.i].hour_utc)}`;
  if ($("infoDialog").open) $("infoDialog").close();
  $("tableDialog").showModal();
}

// ---- wiring
function wire() {
  $("prevHour").addEventListener("click", () => { setPlaying(false); goTo(state.i - 1, { announceIt: true }); });
  $("nextHour").addEventListener("click", () => { setPlaying(false); goTo(state.i + 1, { announceIt: true }); });
  $("playBtn").addEventListener("click", () => setPlaying(!state.playTimer));
  $("timeSlider").addEventListener("input", (e) => { setPlaying(false); goTo(Number(e.target.value), { announceIt: true }); });
  $("viewToggle").addEventListener("click", () => toggle3D());
  $("themeBtn").addEventListener("click", () => applyTheme(isDark() ? "light" : "dark"));
  $("searchBtn").addEventListener("click", openSearch);
  $("infoBtn").addEventListener("click", openInfo);
  $("closeInfo").addEventListener("click", () => $("infoDialog").close());
  $("openTable").addEventListener("click", openTable);
  $("closeTable").addEventListener("click", () => $("tableDialog").close());
  $("closeSheet").addEventListener("click", closeSheet);
  $("sheetBody").addEventListener("click", (e) => { const b = e.target.closest('[data-action="copy-link"]'); if (b) copyLink(b); });
  wireSearch();
  document.addEventListener("visibilitychange", () => { if (document.hidden) setPlaying(false); });
  document.addEventListener("keydown", onKey);
  map.on("click", (e) => {
    const hit = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 6, layerIds: ["st-core"] });
    inspect(hit && hit.object ? { lng: hit.object.lon, lat: hit.object.lat } : e.lngLat);
  });
  map.on("mousemove", (e) => {
    map.getCanvas().style.cursor = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 2 }) ? "pointer" : "";
  });
}
function onKey(e) {
  const t = e.target;
  const tag = (t.tagName || "").toLowerCase();
  const typing = (tag === "input" && !["checkbox", "range", "radio"].includes(t.type)) || tag === "textarea" || t.isContentEditable;
  const dialogOpen = [...document.querySelectorAll("dialog")].some((d) => d.open);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (!dialogOpen) openSearch(); return; }
  if (e.key === "Escape") { if (!dialogOpen) closeSheet(); return; }
  if (typing || dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return;
  const inMap = Boolean(t.closest && t.closest("#map")); // MapLibre uses arrows to pan
  const onControl = tag === "button" || tag === "input";
  switch (e.key) {
    case "/": e.preventDefault(); openSearch(); break;
    case "?": e.preventDefault(); openInfo(); break;
    case "ArrowLeft": case "ArrowRight":
      if (inMap || onControl) return;
      e.preventDefault(); setPlaying(false); goTo(state.i + (e.key === "ArrowRight" ? 1 : -1), { announceIt: true }); break;
    case " ":
      if (inMap || onControl) return;
      e.preventDefault(); setPlaying(!state.playTimer); break;
    case "d": case "D": toggle3D(); break;
    case "t": case "T": applyTheme(isDark() ? "light" : "dark"); break;
    default: if (/^[1-5]$/.test(e.key)) selectStep(STEPS[Number(e.key) - 1].id);
  }
}

(async function init() {
  setLoading(true);
  buildLayers();
  selectStep(state.step);
  wire();
  const want = readHash();
  try {
    const data = await getJSON("/api/hours");
    if (!data.hours.length) {
      setLoading(false);
      $("heroTime").textContent = "No maps yet";
      toast("No map hours yet. Run: python -m aqpipe predict …", 20000);
      return;
    }
    state.hours = data.hours;
    state.skill = data.skill || [];
    $("timeSlider").max = state.hours.length - 1;
    if (want.step) selectStep(want.step);
    if (want.view === "2d" || want.view === "3d") toggle3D(want.view === "3d");
    else if (!state.is3D) toggle3D(false);
    if (want.map) {
      const [lat, lng, zoom, pitch = 38, bearing = -6] = want.map;
      map.jumpTo({ center: [lng, lat], zoom, pitch: state.is3D ? pitch : 0, bearing: state.is3D ? bearing : 0 });
    }
    if (want.at) state.lastClick = { lat: want.at[0], lng: want.at[1] };
    await goTo(Math.max(0, state.hours.findIndex((h) => h.key === want.hour)));
    // Fit once the headline and dock have their real sizes, so India sits in the space between them
    if (!want.map) fitBounds(INDIA, 1600);
    restoring = false;
    writeHash();
  } catch (err) {
    setLoading(false);
    toast(`Could not load the map data: ${err.message}`, 20000);
  }
})();
