import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { STEPS } from "../lib/constants.js";
import { clockLabel, pmRGB, rampPos, rgb, toDayKey } from "../lib/util.js";
import { Icon } from "./Icons.jsx";

const spring = { type: "spring", stiffness: 500, damping: 42 };

function Layers({ step, onSelect }) {
  const box = useRef(null);
  const onKey = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault(); e.stopPropagation();
    const k = (STEPS.findIndex((s) => s.id === step.id) + keys[e.key] + STEPS.length) % STEPS.length;
    onSelect(STEPS[k].id);
    requestAnimationFrame(() => box.current?.querySelector(`[data-step="${STEPS[k].id}"]`)?.focus());
  };
  return (
    <div id="layers" ref={box} className="seg" role="radiogroup" aria-label="Map layer" onKeyDown={onKey}>
      {STEPS.map((s, k) => {
        const on = s.id === step.id;
        return (
          <button key={s.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-step={s.id}
            aria-keyshortcuts={String(k + 1)} onClick={() => onSelect(s.id)} className={on ? "on" : ""}>
            {on && <motion.span layoutId="seg-pill" className="seg-pill" transition={spring} />}
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Legend({ step, dark, hoverValue }) {
  const { title, stops, ramp, last, first } = step.legend;
  const r = ramp(dark);
  const n = stops.length - 1;
  let left = null;
  if (hoverValue !== null && hoverValue !== undefined && Number.isFinite(hoverValue)) {
    const [k, t] = rampPos(hoverValue, stops);
    left = `${((k + t) / n) * 100}%`;
  }
  return (
    <div className="legend" aria-label={`Legend: ${title}`}>
      <span className="legend-title">{title}</span>
      <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${r.map((c, k) => `${c} ${(k / n) * 100}%`).join(", ")})` }}>
        <AnimatePresence>
          {left && <motion.span className="legend-dot" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1, left }}
            exit={{ opacity: 0 }} transition={{ type: "spring", stiffness: 700, damping: 45 }} />}
        </AnimatePresence>
      </div>
      <div className="legend-ticks tnum">
        {stops.map((s, k) => <span key={k}>{k === n ? last : k === 0 && first ? first : (s > 0 && first ? `+${s}` : String(s).replace("-", "−"))}</span>)}
      </div>
    </div>
  );
}

/** Bottom bar: layer switch, then every scan hour as a column of India's median PM2.5. */
export default function Timeline({ step, onStep, hours, index, onIndex, playing, onPlay, dark, hoverValue, phone }) {
  const strip = useRef(null);
  const first = useRef(true);
  useEffect(() => { // keep the selected hour in view; jump on first render, glide after
    const box = strip.current, chip = box?.querySelector(".col.on");
    if (!chip) return;
    const left = chip.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft - box.clientWidth / 2 + chip.clientWidth / 2;
    box.scrollTo({ left, behavior: first.current ? "auto" : "smooth" });
    first.current = false;
  }, [index, hours.length, phone]);
  const days = [];
  hours.forEach((h, k) => {
    const day = toDayKey(h.hour_utc);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
    days[days.length - 1].items.push({ ...h, k });
  });
  return (
    <motion.footer className="timeline surface" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}>
      <div className="tl-top">
        <Layers step={step} onSelect={onStep} />
        {!phone && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={step.id} className="tl-caption" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}>{step.caption}</motion.p>
          </AnimatePresence>
        )}
      </div>
      <div className="tl-mid">
        <motion.button className="play" type="button" aria-label={playing ? "Pause" : "Play through hours"} aria-pressed={playing}
          onClick={onPlay} whileTap={{ scale: 0.9 }}><Icon name={playing ? "pause" : "play"} size={16} /></motion.button>
        <div className="strip" ref={strip} role="radiogroup" aria-label="Scan hour: India median PM2.5" onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key] ?? (e.key === "Home" ? -index : e.key === "End" ? hours.length - 1 - index : 0);
          if (!step) return;
          e.preventDefault(); e.stopPropagation();
          const next = Math.min(hours.length - 1, Math.max(0, index + step));
          onIndex(next);
          requestAnimationFrame(() => strip.current?.querySelector(`[data-k="${next}"]`)?.focus());
        }}>
          {days.map((d) => (
            <div className="day" key={d.day}>
              <span className="day-label mono">{d.day}</span>
              <div className="day-cols">
                {d.items.map((h) => {
                  const on = h.k === index;
                  const m = h.median_pm25;
                  return (
                    <button key={h.key} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-k={h.k} className={`col${on ? " on" : ""}`}
                      aria-label={`${d.day} ${clockLabel(h.hour_utc)} IST, India median ${m === undefined ? "unknown" : Math.round(m)} µg/m³`}
                      onClick={() => onIndex(h.k)}>
                      <span className="col-v mono">{m === undefined ? "–" : Math.round(m)}</span>
                      <span className="col-plot"><span className="col-bar" style={{ height: `${Math.max(6, Math.min(1, (m || 0) / 60) * 100)}%`,
                        background: m === undefined ? "var(--ink-3)" : rgb(pmRGB(m)) }} /></span>
                      <span className="col-t mono">{clockLabel(h.hour_utc)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Legend step={step} dark={dark} hoverValue={hoverValue} />
    </motion.footer>
  );
}
