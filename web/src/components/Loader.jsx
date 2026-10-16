import { useEffect, useRef } from "react";
import { motion, useIsPresent, useSpring, useTransform } from "framer-motion";
import GlobeScene from "./GlobeScene.jsx";
import { Wordmark } from "./Logo.jsx";

const EASE = [0.16, 1, 0.3, 1];
/** Splash: the globe, the wordmark beneath it, and one status line under a hairline. */
export default function Loader({ steps, progress }) {
  const slot = useRef(null);
  const present = useIsPresent();
  const spring = useSpring(0, { stiffness: 70, damping: 22 });
  useEffect(() => { spring.set(progress); }, [progress, spring]);
  const pct = useTransform(spring, (v) => `${Math.round(v * 100)}%`);
  const current = steps.find((s) => s.status === "error") || steps.find((s) => s.status === "active")
    || [...steps].reverse().find((s) => s.status === "done") || steps[0];
  const failed = current?.status === "error";

  return (
    <motion.div className="loader" role="status" aria-live="polite" aria-label="Loading Airscope"
      exit={{ opacity: 0 }} transition={{ duration: 0.9, ease: [0.7, 0, 0.84, 0] }}>
      <GlobeScene slot={slot} leaving={!present} />

      <motion.div className="loader-stage" exit={{ opacity: 0, y: -12, transition: { duration: 0.35, ease: EASE } }}>
        <div className="globe-slot" ref={slot} aria-hidden="true" />
        <Wordmark as="h1" className="loader-wordmark" intro />
        <motion.p className="loader-tag" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.0, duration: 0.9, ease: EASE }}>
          Hourly PM2.5 for all of India at 0.1°, estimated from INSAT-3DR aerosol retrievals
        </motion.p>
      </motion.div>

      <motion.div className="loader-foot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1, duration: 0.8 }}
        exit={{ opacity: 0, transition: { duration: 0.25 } }}>
        <div className="loader-track"><motion.span style={{ scaleX: spring }} /></div>
        <div className="loader-msg mono">
          <motion.span key={`${current?.label}-${current?.status}`} className={failed ? "err" : ""}
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            {current?.label}{current?.detail ? <span className="dim"> · {current.detail}</span> : null}
          </motion.span>
          <motion.span className="dim tnum">{pct}</motion.span>
        </div>
      </motion.div>
    </motion.div>
  );
}
