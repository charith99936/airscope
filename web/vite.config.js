import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the app on :5173 and forwards /api to the FastAPI server (python -m aqpipe serve, :8765).
// `npm run build` writes web/dist, which the FastAPI server then serves at "/".
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8765" } },
  build: { outDir: "dist", chunkSizeWarningLimit: 2500 },
});
