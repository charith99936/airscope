import { NAQI, PM_RAMP, PM_STOPS } from "./constants.js";
import { makeGrid } from "./raster.js";

// ---- colour
export const hexToRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function rampPos(v, stops) { // segment index + fraction along a piecewise ramp
  const x = Math.min(Math.max(v, stops[0]), stops[stops.length - 1]);
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1]) k++;
  return [k, (x - stops[k]) / (stops[k + 1] - stops[k] || 1)];
}
export function rampRGB(v, stops, ramp) {
  const [k, t] = rampPos(v, stops);
  const a = hexToRGB(ramp[k]), b = hexToRGB(ramp[k + 1]);
  return a.map((c, i) => Math.round(c + (b[i] - c) * t));
}
export const pmRGB = (v) => rampRGB(v, PM_STOPS, PM_RAMP);
export const rgb = (c) => `rgb(${c.join(",")})`;
export const naqi = (v) => NAQI.reduce((label, [lo, name]) => (v >= lo ? name : label), NAQI[0][1]);
export const fmt = (v, d = 0, unit = "") => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${unit}`);
export const cleanName = (n) => String(n).split(" - ")[0].trim();

// ---- time labels (data is UTC, people read IST)
const toDate = (utc) => new Date(utc.replace(" ", "T") + "Z");
export const dateLabel = (utc) => toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
export const clockLabel = (utc) => toDate(utc).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
export const dayLabel = (utc) => toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
export const toDayKey = (utc) => toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
export const shortLabel = (utc) => `${toDate(utc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}, ${clockLabel(utc)}`;

// ---- data
export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const detail = await r.json().then((j) => j.detail).catch(() => null);
    throw Object.assign(new Error(detail || `${r.status} ${url}`), { status: r.status, detail });
  }
  return r.json();
}

export function landStats(c) {
  const pm = c.pm25.filter((v) => v >= 0);
  const sorted = Float64Array.from(pm).sort();
  return {
    n: pm.length, median: sorted[Math.floor(sorted.length / 2)],
    counts: NAQI.map(([lo], k) => pm.filter((v) => v >= lo && (k === NAQI.length - 1 || v < NAQI[k + 1][0])).length),
    poor: pm.filter((v) => v >= 90).length / pm.length,
  };
}
export async function loadHour(key) {
  const [cells, st, meta] = await Promise.all([getJSON(`/api/cells/${key}`), getJSON(`/api/stations/${key}`), getJSON(`/api/meta/${key}`)]);
  return { grid: makeGrid(cells), stations: st.stations, meta, stats: landStats(cells) };
}

/** Cities (from "Station, City - Agency" names) and stations, for search and map labels. */
export function buildPlaces(stations) {
  const byCity = new Map();
  const list = stations.map((s) => {
    const label = cleanName(s.name);
    const parts = label.split(",").map((x) => x.trim()).filter(Boolean);
    const city = parts[parts.length - 1] || label;
    const c = byCity.get(city) || { name: city, lat: 0, lon: 0, n: 0 };
    c.lat += s.lat; c.lon += s.lon; c.n += 1;
    byCity.set(city, c);
    return { kind: "station", name: label, sub: city !== label ? city : "Station", lat: s.lat, lon: s.lon };
  });
  const cities = [...byCity.values()].map((c) => ({ kind: "city", name: c.name, lat: c.lat / c.n, lon: c.lon / c.n, n: c.n,
    sub: `${c.n} station${c.n > 1 ? "s" : ""}` }));
  return { cities, stations: list };
}

// ---- shareable URL: #h=hour&s=layer&map=lat,lng,zoom&at=lat,lng
export function readHash() {
  const out = {};
  window.location.hash.slice(1).split("&").filter(Boolean).forEach((kv) => { const [k, v] = kv.split("="); out[k] = decodeURIComponent(v || ""); });
  const nums = (s, n) => { const a = (s || "").split(",").map(Number); return a.length >= n && a.every(Number.isFinite) ? a : null; };
  return { hour: out.h, step: out.s, map: nums(out.map, 3), at: nums(out.at, 2) };
}
export function writeHash({ hourKey, step, view, at }) {
  const parts = [`h=${hourKey}`, `s=${step}`];
  if (view) parts.push(`map=${view.lat.toFixed(3)},${view.lng.toFixed(3)},${view.zoom.toFixed(2)}`);
  if (at) parts.push(`at=${at.lat.toFixed(3)},${at.lng.toFixed(3)}`);
  window.history.replaceState(null, "", `#${parts.join("&")}`);
}

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
