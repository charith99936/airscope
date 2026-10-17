import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, setWorkerUrl } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { THEME } from "../lib/constants.js";
import { hexToRGB, pmRGB } from "../lib/util.js";
import { paintLayer, valueAt } from "../lib/raster.js";

// MapLibre 6 ships its worker as an ES module next to a shared chunk; both are copied to public/maplibre
// (npm run build does it via the "prebuild" script) because Vite does not bundle them.
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FIELD = ["field-a", "field-b"]; // two canvas layers, cross-faded when the hour or layer changes
const FULL = [[60, 40], [100, 40], [100, 0], [60, 0]];

function baseStyle(theme, canvases) {
  const t = THEME[theme];
  const field = (id) => [
    { id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: REDUCED ? 0 : 650 }, "raster-fade-duration": 0, "raster-resampling": "linear" } },
  ];
  return {
    version: 8,
    sources: {
      land: { type: "geojson", data: "/land-world-110m.geojson", attribution: "Natural Earth" },
      india: { type: "geojson", data: "/india.geojson" }, // India's own point-of-view boundary
      "field-a": { type: "canvas", canvas: canvases[0], coordinates: FULL, animate: false },
      "field-b": { type: "canvas", canvas: canvases[1], coordinates: FULL, animate: false },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": t.bg } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": t.land } },
      { id: "coast", type: "line", source: "land", paint: { "line-color": t.coast, "line-width": 0.7 } },
      { id: "india", type: "fill", source: "india", paint: { "fill-color": t.india } },
      ...field("field-a"), ...field("field-b"),
      { id: "india-line", type: "line", source: "india", paint: { "line-color": t.indiaLine, "line-width": 0.9, "line-opacity": 0.8 } },
    ],
  };
}

let indiaRings = null;
const loadIndia = () => (indiaRings ||= fetch("/india.geojson").then((r) => r.json())
  .then((gj) => gj.features.flatMap((f) => (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]).map((p) => p[0]))));

/**
 * The map: a quiet land silhouette, the selected layer as a soft colour field over India, stations on top.
 * Imperative handle: fitBounds, flyTo, easeTo, jumpTo, getView.
 */
const MapView = forwardRef(function MapView({ grid, stations, cities, step, theme, pin, onPick, onHover, onMoveEnd, onDrawn }, ref) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const markerRef = useRef(null);
  const front = useRef(0);
  const canvases = useRef(null);
  const [ready, setReady] = useState(false);
  const [painted, setPainted] = useState(false); // stations wait for the first colour field, so they never float on an empty map
  const [zoom, setZoom] = useState(3.9);
  const latest = useRef({});
  latest.current = { onPick, onHover, onMoveEnd, onDrawn, grid, step };

  useEffect(() => {
    canvases.current = [0, 1].map(() => Object.assign(document.createElement("canvas"), { width: 1, height: 1 }));
    const map = new MapLibreMap({
      container: container.current, style: baseStyle(theme, canvases.current), center: [80, 21], zoom: 3.2, // the reveal zooms in from here
      minZoom: 2.6, maxZoom: 10, maxPitch: 0, dragRotate: false, pitchWithRotate: false,
      maxBounds: [[10, -35], [150, 65]], attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    map.on("load", () => setReady(true));
    map.on("click", (e) => {
      const hit = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 6, layerIds: ["st-core"] });
      latest.current.onPick?.(hit?.object ? { lng: hit.object.lon, lat: hit.object.lat } : { lng: e.lngLat.lng, lat: e.lngLat.lat });
    });
    map.on("mousemove", (e) => {
      const st = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 4, layerIds: ["st-core"] });
      const { grid: g, step: s } = latest.current;
      const v = st?.object ? null : valueAt(g, s.layer, e.lngLat.lat, e.lngLat.lng);
      map.getCanvas().style.cursor = st?.object || v !== null ? "pointer" : "";
      latest.current.onHover?.(st?.object
        ? { x: e.point.x, y: e.point.y, station: st.object }
        : v !== null ? { x: e.point.x, y: e.point.y, value: v } : null);
    });
    map.getCanvas().addEventListener("mouseleave", () => latest.current.onHover?.(null));
    map.on("zoomend", () => setZoom(map.getZoom()));
    map.on("moveend", () => latest.current.onMoveEnd?.(view(map)));
    mapRef.current = map;
    overlayRef.current = overlay;
    return () => { map.remove(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    fitBounds: (b, opts = {}) => mapRef.current?.fitBounds(b, { duration: REDUCED ? 0 : 1600, ...opts }),
    flyTo: (opts) => mapRef.current?.flyTo({ duration: REDUCED ? 0 : 1600, ...opts }),
    easeTo: (opts) => mapRef.current?.easeTo({ duration: REDUCED ? 0 : 700, ...opts }),
    jumpTo: (opts) => mapRef.current?.jumpTo(opts),
    getView: () => (mapRef.current ? view(mapRef.current) : null),
    cameraFor: (b, opts) => mapRef.current?.cameraForBounds(b, opts),
    project: (lngLat) => mapRef.current?.project(lngLat),
  }), []);

  // Theme: repaint the basemap
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const t = THEME[theme];
    map.setPaintProperty("sea", "background-color", t.bg);
    map.setPaintProperty("land", "fill-color", t.land);
    map.setPaintProperty("coast", "line-color", t.coast);
    map.setPaintProperty("india", "fill-color", t.india);
    map.setPaintProperty("india-line", "line-color", t.indiaLine);
  }, [theme, ready]);

  // The colour field: paint synchronously into the hidden canvas, upload it once, then cross-fade
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !grid) return undefined;
    let alive = true;
    loadIndia().catch(() => null).then((rings) => {
      if (!alive) return;
      const { stops, ramp } = step.legend;
      const { canvas, coordinates } = paintLayer(grid, step.layer, stops, ramp(theme === "dark"), rings);
      const back = 1 - front.current;
      const target = canvases.current[back];
      target.width = canvas.width; target.height = canvas.height;
      target.getContext("2d").drawImage(canvas, 0, 0);
      const src = map.getSource(FIELD[back]);
      src.setCoordinates(coordinates);
      src.play();                                    // a static canvas source re-uploads only while "playing"
      map.once("render", () => src.pause());
      const first = !painted;
      if (first) map.setPaintProperty(FIELD[back], "raster-opacity-transition", { duration: 0 }); // fully there when the splash lifts
      map.setPaintProperty(FIELD[back], "raster-opacity", theme === "dark" ? 0.82 : 0.88);
      map.setPaintProperty(FIELD[front.current], "raster-opacity", 0);
      front.current = back;
      if (first) {
        map.once("idle", () => {                     // basemap, outline and field are all on screen
          map.setPaintProperty(FIELD[back], "raster-opacity-transition", { duration: REDUCED ? 0 : 650 });
          setPainted(true);
          latest.current.onDrawn?.();
        });
        map.triggerRepaint();
      }
    });
    return () => { alive = false; };
  }, [grid, step, theme, ready]);

  // Stations and city labels
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const t = THEME[theme];
    const ink = hexToRGB(t.ink), bg = hexToRGB(t.bg);
    const obs = (d) => pmRGB(d.observed);
    const labels = zoom < 4.8 ? [] : cities.filter((c) => zoom >= 5.8 || c.n >= 3);
    overlay.setProps({
      layers: [
        new ScatterplotLayer({ // quiet specks at country scale, ringed markers once you zoom in
          id: "st-core", data: painted ? stations.filter((d) => d.observed !== null) : [], getPosition: (d) => [d.lon, d.lat], radiusUnits: "pixels",
          getRadius: zoom < 5 ? 1.8 : 4.5, stroked: zoom >= 5, lineWidthUnits: "pixels", getLineWidth: 1.5,
          getFillColor: (d) => [...obs(d), zoom < 5 ? 210 : 255], getLineColor: [...ink, 230], pickable: true,
          updateTriggers: { getLineColor: [theme], getRadius: [zoom < 5], getFillColor: [zoom < 5] },
        }),
        new TextLayer({
          id: "labels", data: labels, getPosition: (d) => [d.lon, d.lat], getText: (d) => d.name,
          getSize: 12, sizeUnits: "pixels", getPixelOffset: [0, -14], getColor: [...ink, 210],
          fontFamily: "IBM Plex Sans, system-ui, sans-serif", fontWeight: 500, characterSet: "auto",
          fontSettings: { sdf: true }, outlineWidth: 3, outlineColor: [...bg, 220],
          updateTriggers: { getColor: [theme], outlineColor: [theme] },
        }),
      ],
    });
  }, [stations, cities, theme, zoom, painted]);

  // The pin on the inspected spot
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!pin) { markerRef.current?.remove(); markerRef.current = null; return; }
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.className = "pin";
      markerRef.current = new Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
    } else markerRef.current.setLngLat([pin.lng, pin.lat]);
  }, [pin]);

  return <div ref={container} className="map" role="application" aria-label="Map of India. Click anywhere to see the PM2.5 estimate there." />;
});
export default MapView;

function view(map) {
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
}
