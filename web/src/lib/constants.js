// Colour: the data is the only colour on the page (ramps checked for monotone lightness;
// PM2.5 stops anchored on India's National AQI breakpoints).
export const NAQI = [[0, "Good"], [30, "Satisfactory"], [60, "Moderate"], [90, "Poor"], [120, "Very poor"], [250, "Severe"]];
export const PM_STOPS = [0, 30, 60, 90, 120, 250, 400];
// Clean green -> lime -> amber -> orange -> coral -> magenta -> violet; tuned to glow on the dark map
export const PM_RAMP = ["#2aa883", "#86c25a", "#e8c04c", "#ef8a3e", "#e2504f", "#b8336f", "#6f2287"];
const AOD_STOPS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];
const SKY_DARK = ["#16336b", "#1f55b8", "#2f7cf0", "#4fb0ff", "#86d8ff", "#c5f0ff", "#ffffff"]; // satellite haze: deep blue -> white
const SKY_LIGHT = ["#dbeafe", "#a9cdfd", "#6aa8fb", "#3b82f6", "#2361d6", "#1c45a3", "#13285e"];
const DIV_STOPS = [-60, -30, -10, 0, 10, 30, 60];
const DIV_DARK = ["#3d7bff", "#5f97ff", "#9dbcf5", "#3a4256", "#f7a8b8", "#ff6b8a", "#ff2d6f"]; // blue (cleaner) <-> rose (dirtier)
const DIV_LIGHT = ["#1e40af", "#3b82f6", "#bfdbfe", "#eef1f6", "#fecdd3", "#f43f5e", "#9f1239"];

export const FAR_KM = 150;   // beyond this from any training station, flag low confidence
export const INDIA = [[67, 6.5], [98, 37.5]];
export const FULL_MODEL = "LightGBM: weather + CAMS + INSAT AOD";

// CPCB National AQI health statements
export const HEALTH = {
  Good: "Minimal impact.",
  Satisfactory: "Minor breathing discomfort to sensitive people.",
  Moderate: "Breathing discomfort to people with lung disease such as asthma, and to people with heart disease.",
  Poor: "Breathing discomfort to most people on prolonged exposure.",
  "Very poor": "Respiratory illness on prolonged exposure.",
  Severe: "Affects healthy people and seriously impacts those with existing diseases.",
};

export const REGIONS = [
  { name: "All India", bounds: INDIA },
  { name: "Delhi NCR", bounds: [[76.8, 28.2], [77.6, 28.95]] },
  { name: "Indo-Gangetic Plain", bounds: [[73.5, 23.5], [89, 32]] },
  { name: "Mumbai", bounds: [[72.75, 18.88], [73.15, 19.3]] },
  { name: "Kolkata", bounds: [[88.2, 22.4], [88.55, 22.75]] },
  { name: "Chennai", bounds: [[80.1, 12.9], [80.35, 13.25]] },
  { name: "Bengaluru", bounds: [[77.45, 12.8], [77.75, 13.1]] },
];

export const STEPS = [
  { id: "pm25", layer: "pm25", label: "PM2.5", caption: "Model PM2.5 at ground level, 0.1° grid, trained on 505 CPCB stations",
    legend: { title: "PM2.5 · µg/m³", stops: PM_STOPS, ramp: () => PM_RAMP, last: "400+" } },
  { id: "aod", layer: "aod", label: "Satellite", caption: "INSAT-3DR aerosol optical depth; blank cells are cloud or bright desert",
    legend: { title: "Aerosol optical depth", stops: AOD_STOPS, ramp: (dark) => (dark ? SKY_DARK : SKY_LIGHT), last: "2+" } },
  { id: "cams_pm25", layer: "cams", label: "CAMS", caption: "Copernicus CAMS forecast without INSAT, on the same scale",
    legend: { title: "CAMS PM2.5 · µg/m³", stops: PM_STOPS, ramp: () => PM_RAMP, last: "400+" } },
  { id: "gain", layer: "gain", label: "INSAT effect", caption: "Model with INSAT minus model without it; red means INSAT raised the estimate",
    legend: { title: "Change · µg/m³", stops: DIV_STOPS, ramp: (dark) => (dark ? DIV_DARK : DIV_LIGHT), last: "+60", first: "−60" } },
];
export const stepById = (id) => STEPS.find((s) => s.id === id) || STEPS[0];

// Theme colours the map needs as numbers (CSS variables hold the same values for the UI)
export const THEME = {
  dark: { bg: "#04060b", land: "#0b0f19", coast: "#161c2a", india: "#0e1422", indiaLine: "#5d6b88", ink: "#f5f7fb" },
  light: { bg: "#dfe6f0", land: "#eef2f7", coast: "#cfd8e5", india: "#f8fafc", indiaLine: "#8796ae", ink: "#0b1220" },
};
