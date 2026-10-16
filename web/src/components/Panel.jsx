import { useEffect, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { FAR_KM, HEALTH, NAQI, PM_RAMP, PM_STOPS } from "../lib/constants.js";
import { cleanName, clockLabel, dayLabel, fmt, naqi, pmRGB, rampPos, rgb } from "../lib/util.js";
import { Icon } from "./Icons.jsx";

const EASE = [0.16, 1, 0.3, 1];
const SCALE_GRADIENT = `linear-gradient(90deg, ${PM_RAMP.map((c, k) => `${c} ${(k / (PM_RAMP.length - 1)) * 100}%`).join(", ")})`;
const bandColor = (k) => rgb(pmRGB((PM_STOPS[k] + PM_STOPS[k + 1]) / 2));
const scalePos = (v) => { const [k, t] = rampPos(v, PM_STOPS); return ((k + t) / (PM_STOPS.length - 1)) * 100; };
const lower = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

/** Counts from the previous value to the new one. */
export function CountUp({ value, duration = 0.7 }) {
  const mv = useMotionValue(value);
  const shown = useTransform(mv, (v) => Math.round(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration, ease: EASE });
    return () => controls.stop();
  }, [value, duration, mv]);
  return <motion.span>{shown}</motion.span>;
}

function Section({ label, children, k = 0 }) {
  return (
    <motion.section className="sec" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.05 + k * 0.05 }}>
      {label && <h3 className="label">{label}</h3>}
      {children}
    </motion.section>
  );
}

/** The headline: one big number, its AQI band in that band's colour, and where it sits on the scale. */
function Reading({ label, value, category, children }) {
  return (
    <Section>
      <h2 className="label">{label}</h2>
      <p className="big"><span className="big-num"><CountUp value={value} /></span><span className="big-unit">µg/m³ PM2.5</span></p>
      <p className="cat" style={{ color: rgb(pmRGB(value)) }}>{category}</p>
      <div className="scale" aria-hidden="true">
        <div className="scale-bar" style={{ background: SCALE_GRADIENT }}>
          <motion.span className="scale-mark" initial={false} animate={{ left: `${scalePos(value)}%` }} transition={{ type: "spring", stiffness: 200, damping: 28 }} />
        </div>
        <div className="scale-ticks">{PM_STOPS.slice(0, -1).map((s) => <span key={s} style={{ left: `${scalePos(s)}%` }}>{s}</span>)}</div>
      </div>
      {children}
    </Section>
  );
}

function Overview({ hour, stats, prev }) {
  const pct = (n) => (n / stats.n) * 100;
  const delta = prev ? Math.round(stats.median - prev.stats.median) : null;
  const category = naqi(stats.median);
  return (
    <>
      <Reading label="India, median of all land" value={stats.median} category={category}>
        <p className="body">{HEALTH[category]}</p>
        <p className="meta mono">{dayLabel(hour.hour_utc)}, {clockLabel(hour.hour_utc)} IST
          {delta !== null && delta !== 0 && <> <span className={delta > 0 ? "worse" : "better"}>{delta > 0 ? "+" : "−"}{Math.abs(delta)}</span> vs {clockLabel(prev.hour_utc)}</>}
        </p>
      </Reading>
      <Section label="Share of land by AQI band" k={1}>
        <div className="rows">
          {NAQI.map(([, name], k) => (
            <div className={`row${stats.counts[k] ? "" : " zero"}`} key={name}>
              <span className="row-name">{name}</span>
              <span className="row-track"><motion.span style={{ background: bandColor(k) }} initial={false}
                animate={{ width: `${Math.max(pct(stats.counts[k]), stats.counts[k] ? 0.8 : 0)}%` }} transition={{ type: "spring", stiffness: 160, damping: 26 }} /></span>
              <span className="row-v mono">{pct(stats.counts[k]) < 1 && stats.counts[k] ? "<1" : Math.round(pct(stats.counts[k]))}%</span>
            </div>
          ))}
        </div>
      </Section>
      <p className="foot">Select any point on the map for its estimate, model comparison and drivers.</p>
    </>
  );
}

const blhNote = (m) => (m < 500 ? "low; traps pollution" : m < 1000 ? "moderate" : "deep; dilutes");
const windNote = (w) => (w < 2 ? "stagnant" : w < 5 ? "light" : "breezy");
const rhNote = (r) => (r > 80 ? "humid; particles swell" : r > 50 ? "moderate" : "dry");
const aodNote = (a) => (a === null ? "not seen (cloud or bright ground)" : a > 1 ? "very hazy" : a > 0.5 ? "hazy" : "fairly clear");

function Place({ d, onCopy, copied }) {
  const ns = d.nearest_station;
  const near = ns && ns.km <= 25;
  const rows = [
    { label: "Satellite model", v: d.pm25, me: true },
    { label: "Without satellite", v: d.pm25_no_satellite },
    { label: "CAMS forecast", v: d.cams_pm25 },
  ];
  if (near && ns.observed !== null && ns.observed !== undefined) rows.push({ label: "Station measured", v: ns.observed });
  const max = Math.max(...rows.map((r) => r.v || 0), 1) * 1.05;
  const top = Math.max(...d.drivers.map((x) => Math.abs(x.log_effect)), 1e-6);
  const ups = d.drivers.filter((x) => x.pct > 0).slice(0, 2).map((x) => lower(x.driver));
  const downs = d.drivers.filter((x) => x.pct < 0).slice(0, 1).map((x) => lower(x.driver));
  const why = [ups.length ? `Raised mostly by ${ups.join(" and ")}` : "", downs.length ? `lowered by ${downs[0]}` : ""].filter(Boolean).join("; ");
  const inputs = [
    ["Satellite AOD", d.aod === null ? "—" : d.aod.toFixed(2), aodNote(d.aod)],
    ["Mixing height", d.blh === null ? "—" : `${Math.round(d.blh)} m`, d.blh === null ? "" : blhNote(d.blh)],
    ["Humidity", fmt(d.rh, 0, "%"), d.rh === null ? "" : rhNote(d.rh)],
    ["Wind", d.wind === null ? "—" : `${d.wind.toFixed(1)} m/s`, d.wind === null ? "" : windNote(d.wind)],
  ];
  return (
    <>
      <Reading label={near ? cleanName(ns.name) : "Selected point"} value={d.pm25} category={d.category}>
        <p className="body">{HEALTH[d.category]}</p>
        <p className="meta mono">{d.cell.lat.toFixed(2)}°N {d.cell.lon.toFixed(2)}°E{near ? `, ${ns.km.toFixed(1)} km from station` : ""}</p>
        {ns && ns.km > FAR_KM && <p className="warn">Nearest station is {Math.round(ns.km)} km away, so treat this estimate with caution.</p>}
      </Reading>
      <Section label="Same point, other estimates" k={1}>
        <div className="rows">
          {rows.map((r) => (
            <div className={`row${r.me ? " me" : ""}`} key={r.label}>
              <span className="row-name">{r.label}</span>
              <span className="row-track"><motion.span style={{ background: r.v === null ? "transparent" : rgb(pmRGB(r.v)) }}
                initial={{ width: 0 }} animate={{ width: `${((r.v || 0) / max) * 100}%` }} transition={{ type: "spring", stiffness: 140, damping: 24 }} /></span>
              <span className="row-v mono">{fmt(r.v)}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section label="What moved this estimate" k={2}>
        <p className="body strong">{why || "No single input dominates"}.</p>
        <div className="drivers">
          {d.drivers.slice(0, 5).map((x) => {
            const w = (Math.abs(x.log_effect) / top) * 50;
            return (
              <div className="drv" key={x.driver}>
                <span className="drv-name">{x.driver}</span>
                <span className="row-track mid"><span style={{ left: `${x.log_effect >= 0 ? 50 : 50 - w}%`, width: `${w}%`,
                  background: x.log_effect >= 0 ? "var(--up)" : "var(--down)" }} /></span>
                <span className="row-v mono">{x.pct >= 0 ? "+" : "−"}{Math.abs(Math.round(x.pct))}%</span>
              </div>
            );
          })}
        </div>
        <p className="meta">Relative to the training average of {Math.round(d.baseline_pm25)} µg/m³ (SHAP).</p>
      </Section>
      <Section label="Inputs at this point" k={3}>
        <dl className="inputs">
          {inputs.map(([t, v, n]) => <div key={t}><dt>{t}</dt><dd className="mono">{v}</dd><dd className="note">{n}</dd></div>)}
        </dl>
      </Section>
      <button className="link-btn" type="button" onClick={onCopy}><Icon name={copied ? "check" : "link"} size={14} />{copied ? "Link copied" : "Copy link to this point"}</button>
    </>
  );
}

/** The left sheet on desktop, a bottom sheet on phones: India's summary, or the selected point. */
export default function Panel({ hour, stats, prev, sheet, onClose, onCopy, copied, phone }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (sheet) setOpen(true); }, [sheet]);
  const placeKey = sheet ? `${sheet.at.lat.toFixed(3)},${sheet.at.lng.toFixed(3)}` : "india";
  return (
    <motion.aside className={`panel${phone && open ? " open" : ""}`} aria-label={sheet ? "Selected point" : "India this hour"}
      initial={{ opacity: 0, y: phone ? 40 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}>
      {phone && <button className="grabber" type="button" aria-label={open ? "Collapse details" : "Expand details"}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}><span /></button>}
      {sheet && <button className="back" type="button" onClick={onClose}><Icon name="prev" size={14} />India</button>}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={placeKey} className="sheet-body" exit={{ opacity: 0, transition: { duration: 0.12 } }}>
          {!sheet && <Overview hour={hour} stats={stats} prev={prev} />}
          {sheet?.loading && <div className="skeleton"><span /><span /><span /></div>}
          {sheet?.error && <p className="body">{sheet.error}</p>}
          {sheet?.data && <Place d={sheet.data} onCopy={onCopy} copied={copied} />}
        </motion.div>
      </AnimatePresence>
    </motion.aside>
  );
}
