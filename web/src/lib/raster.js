import { rampRGB } from "./util.js";

// The model grid is 0.1° cells in plain lat/lon. MapLibre stretches an image linearly in Web Mercator,
// so rows are resampled to Mercator spacing here; otherwise central India would sit ~0.5° off its outline.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMerc = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
const SCALE = 4; // output pixels per cell, before the soft blur

/** /api/cells payload -> a grid with a cell index for O(1) lookups. Negative values mean "no data". */
export function makeGrid(c) {
  let maxIdx = 0;
  for (let k = 0; k < c.idx.length; k++) if (c.idx[k] > maxIdx) maxIdx = c.idx[k];
  const nlat = Math.floor(maxIdx / c.nlon) + 1;
  const pos = new Int32Array(nlat * c.nlon).fill(-1);
  for (let k = 0; k < c.idx.length; k++) pos[c.idx[k]] = k;
  const s = c.step / 2;
  return { ...c, nlat, pos, west: c.lon0 - s, east: c.lon0 + (c.nlon - 1) * c.step + s, south: c.lat0 - s, north: c.lat0 + (nlat - 1) * c.step + s };
}

/** One layer's value in cell k: PM2.5 and CAMS in µg/m³, AOD unitless (stored x100), gain = with minus without satellite. */
export function cellValue(g, layer, k) {
  switch (layer) {
    case "pm25": return g.pm25[k] >= 0 ? g.pm25[k] : null;
    case "cams": return g.cams_pm25[k] >= 0 ? g.cams_pm25[k] : null;
    case "aod": return g.aod[k] >= 0 ? g.aod[k] / 100 : null;
    case "gain": return g.pm25[k] >= 0 && g.pm25_no_satellite[k] >= 0 ? g.pm25[k] - g.pm25_no_satellite[k] : null;
    default: return null;
  }
}

export function valueAt(g, layer, lat, lng) {
  if (!g) return null;
  const i = Math.round((lat - g.lat0) / g.step), j = Math.round((lng - g.lon0) / g.step);
  if (i < 0 || j < 0 || i >= g.nlat || j >= g.nlon) return null;
  const k = g.pos[i * g.nlon + j];
  return k < 0 ? null : cellValue(g, layer, k);
}

/** Paint a layer as a soft colour field clipped to India; returns a canvas plus its corner coordinates for MapLibre. */
export function paintLayer(g, layer, stops, ramp, rings) {
  const src = document.createElement("canvas");
  src.width = g.nlon; src.height = g.nlat;
  const sctx = src.getContext("2d");
  const img = sctx.createImageData(g.nlon, g.nlat);
  for (let k = 0; k < g.idx.length; k++) {
    const v = cellValue(g, layer, k);
    if (v === null) continue;
    const i = Math.floor(g.idx[k] / g.nlon), j = g.idx[k] - i * g.nlon;
    const p = ((g.nlat - 1 - i) * g.nlon + j) * 4;
    const [r, gg, b] = rampRGB(v, stops, ramp);
    img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);

  const yN = mercY(g.north), yS = mercY(g.south);
  const W = g.nlon * SCALE;
  const H = Math.round((W * (yN - yS)) / (((g.east - g.west) * Math.PI) / 180));
  const tmp = document.createElement("canvas");
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = "high";
  for (let y = 0; y < H; y++) {
    const lat = invMerc(yN - ((y + 0.5) / H) * (yN - yS));
    const sy = (g.north - lat) / g.step - 0.5;
    tctx.drawImage(src, 0, Math.max(0, sy), g.nlon, 1, 0, y, W, 1);
  }

  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");
  if (rings?.length) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([lon, lat], n) => {
        const x = ((lon - g.west) / (g.east - g.west)) * W, y = ((yN - mercY(lat)) / (yN - yS)) * H;
        if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
    }
    ctx.clip();
  }
  ctx.filter = `blur(${SCALE * 0.9}px)`;
  ctx.drawImage(tmp, 0, 0);
  return { canvas: out, coordinates: [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]] };
}
