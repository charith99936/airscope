import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { REGIONS } from "../lib/constants.js";
import { cleanName, fmt, shortLabel } from "../lib/util.js";
import { Icon } from "./Icons.jsx";

/** Animated modal: blurred backdrop, scale-in panel, focus kept inside, Esc or backdrop click closes. */
export function Modal({ open, onClose, label, className = "", children, initialFocus }) {
  const panel = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    requestAnimationFrame(() => (initialFocus?.current || panel.current?.querySelector("button, input, [tabindex]"))?.focus());
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Tab" && panel.current) { // keep Tab inside the panel
        const items = [...panel.current.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); opener.current?.focus?.(); };
  }, [open, onClose, initialFocus]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="backdrop" key="bd" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <motion.div ref={panel} className={`modal surface ${className}`} role="dialog" aria-modal="true" aria-label={label}
            initial={{ opacity: 0, scale: 0.96, y: -10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const ICON = { region: "region", city: "pin", station: "dot" };
function findPlaces(q, places) {
  const t = q.trim().toLowerCase();
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

export function SearchPalette({ open, onClose, places, onChoose }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const items = useMemo(() => (q.trim() ? findPlaces(q, places) : REGIONS.map((r) => ({ ...r, kind: "region", sub: "Region" }))), [q, places]);
  useEffect(() => { if (open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  const choose = (p) => { if (p) { onChoose(p); onClose(); } };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % Math.max(items.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % Math.max(items.length, 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[active]); }
  };
  return (
    <Modal open={open} onClose={onClose} label="Search places" className="palette" initialFocus={input}>
      <div className="palette-input">
        <Icon name="search" size={20} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search a city or station"
          role="combobox" aria-expanded="true" aria-controls="results" aria-autocomplete="list"
          aria-activedescendant={items.length ? `place-${active}` : undefined} autoComplete="off" spellCheck="false" />
        <kbd>esc</kbd>
      </div>
      <motion.ul id="results" className="results" role="listbox" aria-label="Places" key={q.trim() ? "q" : "popular"}
        initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.025 } } }}>
        {!q.trim() && <li className="group" role="presentation">Popular places</li>}
        {items.length ? items.map((p, k) => (
          <motion.li key={`${p.kind}-${p.name}`} id={`place-${k}`} role="option" aria-selected={k === active}
            className="option" onMouseEnter={() => setActive(k)} onClick={() => choose(p)}
            variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}>
            <Icon name={ICON[p.kind]} />
            <span className="opt-name">{p.name}</span><span className="opt-sub">{p.sub}</span>
          </motion.li>
        )) : <li className="empty" role="presentation">Nothing matches “{q}”. Try a nearby city, or click the map.</li>}
      </motion.ul>
    </Modal>
  );
}

export function InfoModal({ open, onClose, skill, stationsLive, demo, onOpenTable }) {
  return (
    <Modal open={open} onClose={onClose} label="About Airscope" className="info">
      <button className="icon-btn close" type="button" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      <h2>How Airscope estimates PM2.5</h2>
      <p className="lead">India has about 500 ground monitors, mostly in big cities. ISRO's INSAT-3DR sees the whole country every
        half hour. Airscope turns what the satellite sees into the PM2.5 you breathe.</p>
      <ol className="steps-list">
        <li><b>PM2.5:</b> a model trained on CPCB stations turns satellite haze + weather into µg/m³, coloured by India's AQI bands.</li>
        <li><b>Satellite:</b> aerosol optical depth: how much sunlight the whole air column blocks. Gaps are clouds or bright desert.</li>
        <li><b>CAMS:</b> the European forecast, with no INSAT input, on the same scale.</li>
        <li><b>INSAT effect:</b> the model with the satellite minus the model without it. Red means INSAT raised the estimate.</li>
      </ol>
      <div className="info-grid">
        <section>
          <h3>Model check</h3>
          <p className="small">{skill
            ? `At stations in whole areas held out of training: R² ${skill.r2.toFixed(2)}, typical miss ${skill.mae.toFixed(0)} µg/m³. ${stationsLive} stations reported this hour.`
            : "Measured at stations in whole areas held out of training."}</p>
          <button className="text-btn" type="button" onClick={onOpenTable}>See every station this hour →</button>
        </section>
        <section>
          <h3>Shortcuts</h3>
          <dl className="keys">
            <dt><kbd>/</kbd></dt><dd>Search</dd><dt><kbd>←</kbd><kbd>→</kbd></dt><dd>Hour</dd>
            <dt><kbd>space</kbd></dt><dd>Play</dd><dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Layer</dd>
            <dt><kbd>T</kbd></dt><dd>Theme</dd>
          </dl>
        </section>
      </div>
      <p className="fine">Data: INSAT-3DR L2G AOD (ISRO MOSDAC) · CPCB stations via OpenAQ · ERA5 and CAMS via Open-Meteo ·
        outlines: Natural Earth (India's point of view). AQI categories use 24-hour averages; these are one-hour estimates.
        Estimates more than 150 km from a station carry a caution note. {demo}</p>
    </Modal>
  );
}

export function StationsModal({ open, onClose, stations, hour }) {
  const rows = useMemo(() => stations
    .map((s) => ({ ...s, miss: s.observed !== null && s.predicted !== null ? s.predicted - s.observed : null }))
    .sort((a, b) => (b.miss === null) - (a.miss === null) || Math.abs(b.miss || 0) - Math.abs(a.miss || 0)), [stations]);
  return (
    <Modal open={open} onClose={onClose} label="Stations" className="wide">
      <button className="icon-btn close" type="button" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      <h2>Stations · {hour ? shortLabel(hour.hour_utc) : ""}</h2>
      <p className="small muted">Observed PM2.5 next to the model's value for that spot, biggest misses first.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Station</th><th scope="col" className="num">Observed</th><th scope="col" className="num">Model</th><th scope="col" className="num">Miss</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.station_id}>
                <td>{cleanName(s.name)}</td><td className="num">{fmt(s.observed)}</td><td className="num">{fmt(s.predicted)}</td>
                <td className="num">{s.miss === null ? "—" : `${s.miss >= 0 ? "+" : "−"}${Math.abs(Math.round(s.miss))}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function Toast({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div className="toast surface" role="alert" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
          <Icon name="alert" />{message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
