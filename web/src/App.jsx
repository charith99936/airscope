import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import MapView from "./map/MapView.jsx";
import Loader from "./components/Loader.jsx";
import Panel from "./components/Panel.jsx";
import Timeline from "./components/Timeline.jsx";
import { Wordmark } from "./components/Logo.jsx";
import { InfoModal, SearchPalette, StationsModal, Toast } from "./components/Overlays.jsx";
import { Icon } from "./components/Icons.jsx";
import { FULL_MODEL, INDIA, STEPS, stepById } from "./lib/constants.js";
import { buildPlaces, cleanName, fmt, getJSON, loadHour, naqi, pmRGB, readHash, rgb, shortLabel, storage, writeHash } from "./lib/util.js";

const MapPane = memo(MapView); // (not `Map`: that would shadow the built-in Map used for the cache)
const MIN_SPLASH_MS = 2600;
const HOLD_SPLASH = new URLSearchParams(window.location.search).has("splash"); // ?splash keeps the loading screen up, for design review
const BOOT_STEPS = [
  { label: "Connecting to INSAT-3DR", detail: "", status: "active" },
  { label: "Reading the satellite grid", detail: "", status: "pending" },
  { label: "Placing ground stations", detail: "", status: "pending" },
  { label: "Drawing the map", detail: "", status: "pending" },
];
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MAP_TIMEOUT_MS = 10000; // if WebGL never reports in, reveal anyway rather than hang on the splash

function useWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

// Space the map leaves for the panel (left) and the timeline (bottom)
// (before the chrome exists, e.g. under the splash, it falls back to the layout tokens)
function viewPadding() {
  const tl = document.querySelector(".timeline")?.getBoundingClientRect();
  const panel = document.querySelector(".panel")?.getBoundingClientRect();
  const css = getComputedStyle(document.documentElement);
  const gap = parseFloat(css.getPropertyValue("--gap")) || 16, panelW = parseFloat(css.getPropertyValue("--panel-w")) || 340;
  if (window.innerWidth < 768) return { top: (tl ? tl.bottom : gap + 54 + 172) + 12, bottom: 184, left: 16, right: 16 };
  const bottom = tl ? window.innerHeight - tl.top + 12 : gap + 186;
  return { top: 80, bottom, left: panel ? panel.right + 24 : gap + panelW + 24, right: 48 };
}

function HoverTip({ hover, step }) {
  if (!hover) return null;
  const st = hover.station;
  let body;
  if (st) {
    body = <><b>{cleanName(st.name)}</b><span>{st.observed === null ? "No reading this hour" : `${Math.round(st.observed)} µg/m³ measured`}</span></>;
  } else {
    const v = hover.value;
    body = step.id === "aod" ? <><b className="tnum">{v.toFixed(2)}</b><span>aerosol optical depth</span></>
      : step.id === "gain" ? <><b className="tnum">{v >= 0 ? "+" : "−"}{Math.abs(Math.round(v))} µg/m³</b><span>from adding the satellite</span></>
        : <><b className="tnum"><i style={{ background: rgb(pmRGB(v)) }} />{fmt(v)} µg/m³</b><span>{naqi(v)}</span></>;
  }
  return <div className="hover-tip surface" style={{ transform: `translate(${hover.x + 14}px, ${hover.y + 14}px)` }}>{body}</div>;
}

export default function App() {
  const width = useWidth();
  const phone = width < 768;
  const hash = useRef(readHash()).current;
  const [theme, setTheme] = useState(() => storage.get("airscope-theme") || "dark");
  const [hours, setHours] = useState([]);
  const [skill, setSkill] = useState(null);
  const [index, setIndex] = useState(0);
  const [stepId, setStepId] = useState(STEPS.some((s) => s.id === hash.step) ? hash.step : "pm25");
  const [current, setCurrent] = useState(null);
  const [prev, setPrev] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [copied, setCopied] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [booting, setBooting] = useState(true);
  const [revealed, setRevealed] = useState(false); // the UI arrives once the globe has landed on the map
  const [steps, setSteps] = useState(BOOT_STEPS);
  const cache = useRef(new Map());
  const mapRef = useRef(null);
  const sheetAt = useRef(null);
  const mapDrawn = useRef(null); // resolves when the map has painted its first colour field
  const globeTarget = useRef(null); // where India sits on the framed map: the splash globe dives onto it
  const step = stepById(stepId);
  const places = useMemo(() => buildPlaces(current?.stations || []), [current]);
  const progress = steps.filter((s) => s.status === "done").length / steps.length;

  const say = useCallback((msg) => { setToast(msg); window.clearTimeout(say.t); say.t = window.setTimeout(() => setToast(null), 6000); }, []);

  // ---- theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storage.set("airscope-theme", theme);
  }, [theme]);

  // ---- boot: real loading steps drive the splash screen
  useEffect(() => {
    let alive = true;
    const t0 = performance.now();
    const done = (k, detail) => setSteps((s) => s.map((x, i) => (i === k ? { ...x, status: "done", detail }
      : i === k + 1 && x.status === "pending" ? { ...x, status: "active" } : x)));
    (async () => {
      try {
        const h = await getJSON("/api/hours");
        if (!h.hours.length) throw new Error("No map hours yet. Run: python -m aqpipe predict …");
        done(0, `${h.hours.length} scan hours`);
        const start = Math.max(0, h.hours.findIndex((x) => x.key === hash.hour));
        const entry = await loadHour(h.hours[start].key);
        done(1, `${entry.stats.n.toLocaleString()} cells`);
        done(2, `${entry.stations.filter((s) => s.observed !== null).length} reporting`);
        cache.current.set(h.hours[start].key, entry);
        // hand the data to the map now, under the splash, and lift the splash only once the map has drawn it
        const drawn = new Promise((r) => { mapDrawn.current = r; });
        setHours(h.hours);
        setSkill((h.skill || []).find((r) => r.subset === "INSAT AOD available" && r.model === FULL_MODEL && r.r2 !== undefined) || null);
        setIndex(start);
        setCurrent(entry);
        await Promise.race([drawn, new Promise((r) => setTimeout(r, MAP_TIMEOUT_MS))]);
        done(3, "");
        await new Promise((r) => setTimeout(r, Math.max(250, MIN_SPLASH_MS - (performance.now() - t0))));
        if (!alive || HOLD_SPLASH) return;
        // frame the map under the splash, then tell the globe where India is so it lands exactly there
        const map = mapRef.current;
        if (map && hash.map) {
          const [lat, lng, zoom] = hash.map;
          map.jumpTo({ center: [lng, lat], zoom });
        } else if (map) {
          const cam = map.cameraFor(INDIA, { padding: viewPadding() });
          if (cam) {
            map.jumpTo(cam);
            const c = map.project([79, 22]), w = map.project([93.5, 22]).x - map.project([64.5, 22]).x;
            globeTarget.current = { x: c.x, y: c.y, w };
          }
        }
        setBooting(false);
      } catch (err) {
        if (!alive) return;
        setSteps((s) => s.map((x) => (x.status === "active" ? { ...x, status: "error", detail: "failed" } : x)));
        say(`Could not load the map data: ${err.message}`);
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- after the splash: let the globe land (1 s), then bring in the UI and fit the map to its real size
  useEffect(() => {
    if (booting) return undefined;
    const t = window.setTimeout(() => setRevealed(true), REDUCED_MOTION ? 0 : 1000);
    return () => window.clearTimeout(t);
  }, [booting]);
  useEffect(() => {
    if (!revealed) return;
    requestAnimationFrame(() => {
      if (!hash.map) mapRef.current?.fitBounds(INDIA, { padding: viewPadding(), duration: 700, easing: (k) => 1 - (1 - k) ** 3 });
      if (hash.at) inspect({ lat: hash.at[0], lng: hash.at[1] });
    });
  }, [revealed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- hours: load the current one, prefetch neighbours, keep the previous hour for "since" labels
  useEffect(() => {
    if (!hours.length) return undefined;
    let alive = true;
    const load = async (k) => { if (!cache.current.has(k)) cache.current.set(k, await loadHour(k)); return cache.current.get(k); };
    (async () => {
      try {
        const d = await load(hours[index].key);
        if (alive) setCurrent(d);
      } catch (err) { say(`Could not load ${shortLabel(hours[index].hour_utc)}: ${err.message}`); }
      load(hours[(index + 1) % hours.length].key).catch(() => {});
      if (index > 0) {
        const p = await load(hours[index - 1].key).catch(() => null);
        if (alive) setPrev(p ? { ...p, hour_utc: hours[index - 1].hour_utc } : null);
      } else if (alive) setPrev(null);
    })();
    if (sheetAt.current) inspect(sheetAt.current);
    return () => { alive = false; };
  }, [index, hours]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = useCallback((i) => setIndex(() => (hours.length ? (i + hours.length) % hours.length : 0)), [hours]);

  useEffect(() => {
    if (!playing || hours.length < 2) return undefined;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % hours.length), 2200);
    return () => window.clearInterval(t);
  }, [playing, hours]);
  useEffect(() => {
    const onVis = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // ---- inspector
  const inspect = useCallback(async (at) => {
    if (!hours.length && !cache.current.size) return;
    sheetAt.current = at;
    setCopied(false);
    setSheet((s) => ({ at, loading: !s?.data, data: s?.data }));
    const key = hours.length ? hours[index].key : [...cache.current.keys()][0];
    try {
      const d = await getJSON(`/api/point/${key}?lat=${at.lat}&lon=${at.lng}`);
      if (sheetAt.current === at) setSheet({ at, data: d });
    } catch (err) {
      if (sheetAt.current === at) setSheet({ at, error: err.status === 404 ? err.detail : "Could not load this spot." });
    }
  }, [hours, index]);
  const closeSheet = useCallback(() => { sheetAt.current = null; setSheet(null); }, []);

  // ---- shareable URL
  const hashTimer = useRef(null);
  const syncHash = useCallback(() => {
    if (booting || !hours.length) return;
    window.clearTimeout(hashTimer.current);
    hashTimer.current = window.setTimeout(() => writeHash({
      hourKey: hours[index].key, step: stepId, view: mapRef.current?.getView(), at: sheetAt.current,
    }), 250);
  }, [booting, hours, index, stepId]);
  useEffect(syncHash, [syncHash, sheet?.at]);
  useEffect(() => {
    const onHash = () => window.location.reload(); // a pasted link applies like a fresh visit
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const copyLink = useCallback(async () => {
    writeHash({ hourKey: hours[index].key, step: stepId, view: mapRef.current?.getView(), at: sheetAt.current });
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { say("Copy the address bar to share this view."); }
  }, [hours, index, stepId, say]);

  const choosePlace = useCallback((p) => {
    if (p.kind === "region") { mapRef.current?.fitBounds(p.bounds, { padding: viewPadding() }); return; }
    mapRef.current?.flyTo({ center: [p.lon, p.lat], zoom: p.kind === "city" ? 8.2 : 9.2, padding: viewPadding() });
    inspect({ lat: p.lat, lng: p.lon });
  }, [inspect]);

  // ---- keyboard
  const keys = useRef();
  keys.current = { goTo, index };
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = (t.tagName || "").toLowerCase();
      const typing = (tag === "input" && !["checkbox", "range", "radio"].includes(t.type)) || tag === "textarea" || t.isContentEditable;
      const modal = Boolean(document.querySelector('[aria-modal="true"]'));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (!modal) setSearchOpen(true); return; }
      if (e.key === "Escape" && !modal) { closeSheet(); return; }
      if (typing || modal || e.metaKey || e.ctrlKey || e.altKey) return;
      const inMap = Boolean(t.closest?.(".map"));
      const onControl = tag === "button" || tag === "input";
      const k = keys.current;
      switch (e.key) {
        case "/": e.preventDefault(); setSearchOpen(true); break;
        case "?": e.preventDefault(); setInfoOpen(true); break;
        case "ArrowLeft": case "ArrowRight":
          if (inMap || onControl) return;
          e.preventDefault(); setPlaying(false); k.goTo(k.index + (e.key === "ArrowRight" ? 1 : -1)); break;
        case " ": if (inMap || onControl) return; e.preventDefault(); setPlaying((p) => !p); break;
        case "t": case "T": setTheme((x) => (x === "dark" ? "light" : "dark")); break;
        default: if (/^[1-9]$/.test(e.key) && STEPS[Number(e.key) - 1]) setStepId(STEPS[Number(e.key) - 1].id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeSheet]);

  const demo = current?.meta?.note || "";
  const stationsLive = (current?.stations || []).filter((s) => s.observed !== null).length;
  const hour = hours[index];
  const hoverValue = hover?.value ?? (hover?.station?.observed ?? null);

  return (
    <>
      <a className="skip-link" href="#layers">Skip to map controls</a>
      <MapPane ref={mapRef} grid={current?.grid || null} stations={current?.stations || []} cities={places.cities}
        step={step} theme={theme} pin={sheet?.at || null} onPick={inspect} onHover={phone ? undefined : setHover} onMoveEnd={syncHash}
        onDrawn={() => mapDrawn.current?.()} />

      <AnimatePresence>{booting && <Loader key="loader" steps={steps} progress={progress} target={globeTarget} />}</AnimatePresence>

      {revealed && current && hour && (
        <>
          <motion.header className="topbar" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}>
            <div className="brand">
              <Wordmark as="h1" />
              {demo ? <span className="badge warn-badge mono" title={demo}>DEMO DATA</span> : <span className="badge mono">INSAT-3DR · {hours.length} scans · Oct–Jan</span>}
            </div>
            <nav className="tools" aria-label="Tools">
              <button className="search-pill surface" type="button" aria-keyshortcuts="/" onClick={() => setSearchOpen(true)}>
                <Icon name="search" size={16} /><span>Search places</span><kbd>/</kbd>
              </button>
              <motion.button whileTap={{ scale: 0.92 }} className="icon-btn surface" type="button"
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme((x) => (x === "dark" ? "light" : "dark"))}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span key={theme} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }}
                    transition={{ duration: 0.2 }} style={{ display: "grid" }}><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></motion.span>
                </AnimatePresence>
              </motion.button>
              <motion.button whileTap={{ scale: 0.92 }} className="icon-btn surface" type="button" aria-label="About Airscope" aria-keyshortcuts="?"
                onClick={() => setInfoOpen(true)}><Icon name="info" size={17} /></motion.button>
            </nav>
          </motion.header>
          <Panel hour={hour} stats={current.stats} prev={prev} sheet={sheet} onClose={closeSheet} onCopy={copyLink} copied={copied} phone={phone} />
          <Timeline step={step} onStep={setStepId} hours={hours} index={index} onIndex={(i) => { setPlaying(false); goTo(i); }}
            playing={playing} onPlay={() => setPlaying((p) => !p)} dark={theme === "dark"} hoverValue={hoverValue} phone={phone} />
          <HoverTip hover={hover} step={step} />
        </>
      )}

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} places={places} onChoose={choosePlace} />
      <InfoModal open={infoOpen} onClose={() => setInfoOpen(false)} skill={skill} stationsLive={stationsLive} demo={demo}
        onOpenTable={() => { setInfoOpen(false); setTableOpen(true); }} />
      <StationsModal open={tableOpen} onClose={() => setTableOpen(false)} stations={current?.stations || []} hour={hour} />
      <Toast message={toast} />
    </>
  );
}
