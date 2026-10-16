import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {/* "user": framer-motion turns transforms off when the OS asks for reduced motion */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
