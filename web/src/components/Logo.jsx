import { useId } from "react";
import { motion } from "framer-motion";

const EASE = [0.16, 1, 0.3, 1];
const ORBIT = "M-46 0a46 14 0 1 0 92 0a46 14 0 1 0 -92 0"; // the satellite's path, around the globe "o"
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The "o" of airscope: a planet ring in a light gradient, with INSAT on a tilted orbit around it. */
function GlobeO({ intro }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="wm-o" viewBox="-50 -50 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-o`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--wm-o1)" />
          <stop offset="100%" stopColor="var(--wm-o2)" />
        </linearGradient>
        <radialGradient id={`${id}-sat`}>
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="40%" stopColor="#a9cbff" />
          <stop offset="100%" stopColor="#4c8dff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform="rotate(-18)">
        <path className="wm-orbit-back" d="M-46 0a46 14 0 0 1 92 0" />
      </g>
      <motion.circle r="36.5" fill="none" stroke={`url(#${id}-o)`} strokeWidth="15"
        {...(intro ? { initial: { pathLength: 0, rotate: -90 }, animate: { pathLength: 1, rotate: -90 }, transition: { delay: 0.45, duration: 1.1, ease: EASE } } : {})} />
      <path className="wm-meridian" d="M0 -29a12 29 0 1 0 0 58a12 29 0 1 0 0 -58M-29 0h58" />
      <g transform="rotate(-18)">
        <path className="wm-orbit-front" d="M46 0a46 14 0 0 1 -92 0" />
        {intro && !REDUCED ? (
          <g className="wm-sat" opacity="0">
            <circle r="12" fill={`url(#${id}-sat)`} />
            <circle r="4.6" fill="#fff" />
            {/* front half (bottom) bright, back half dimmed as it passes behind the globe */}
            <animateMotion dur="3.6s" begin="1s" repeatCount="indefinite" path={ORBIT} />
            <animate attributeName="opacity" values="1;1;0.25;0.25;1" keyTimes="0;0.44;0.52;0.94;1" dur="3.6s" begin="1s" repeatCount="indefinite" />
          </g>
        ) : (
          <g className="wm-sat" transform="translate(-35 9.1)">
            <circle r="12" fill={`url(#${id}-sat)`} />
            <circle r="4.6" fill="#fff" />
          </g>
        )}
      </g>
    </svg>
  );
}

/**
 * The airscope wordmark in Inter: "air" light, "scope" bold, and the o is a little globe with a satellite.
 * `intro` reveals the letters from a mask and starts the satellite on its orbit.
 */
export function Wordmark({ className = "", intro = false, as: Tag = "span" }) {
  const letter = (k) => (intro ? {
    initial: { y: "105%" }, animate: { y: "0%" }, transition: { delay: 0.2 + k * 0.045, duration: 0.9, ease: EASE },
  } : {});
  const chars = ["a", "i", "r", "s", "c", "o", "p", "e"];
  return (
    <Tag className={`wordmark ${className}`} aria-label="airscope">
      {chars.map((ch, k) => (
        <span className={`wm-mask${k < 3 ? " wm-light" : ""}${ch === "o" ? " wm-mask-o" : ""}`} key={k} aria-hidden="true">
          <motion.span className="wm-ch" {...letter(k)}>{ch === "o" ? <GlobeO intro={intro} /> : ch}</motion.span>
        </span>
      ))}
    </Tag>
  );
}
