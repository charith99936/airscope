import { Component, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";

const DEG = Math.PI / 180;
const INDIA = { lat: 22, lon: 79 };
const INSAT_LON = 74;            // INSAT-3DR's geostationary slot
const ORBIT = 1.62;              // stylised orbit radius (the real one is 6.6 Earth radii)
const TILT = 19 * DEG;           // tip the north toward us so India sits just above centre
const SUN = new THREE.Vector3(-0.62, 0.42, 0.66).normalize();
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const toXYZ = (lat, lon, r = 1) => {
  const p = lat * DEG, l = lon * DEG;
  return new THREE.Vector3(r * Math.cos(p) * Math.sin(l), r * Math.sin(p), r * Math.cos(p) * Math.cos(l));
};
const easeOut = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

// One clock-and-fade uniform pair shared by every material, so the whole planet fades in together
const shared = { uTime: { value: 0 }, uFade: { value: 0 }, uSun: { value: SUN } };

const oceanMat = new THREE.ShaderMaterial({
  uniforms: shared,
  vertexShader: /* glsl */`
    varying vec3 vN;
    void main() {
      vN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSun; uniform float uFade;
    varying vec3 vN;
    void main() {
      float l = max(dot(vN, uSun), 0.0);
      vec3 col = mix(vec3(0.0015, 0.003, 0.009), vec3(0.006, 0.018, 0.055), smoothstep(0.0, 1.0, l));
      float rim = pow(1.0 - max(vN.z, 0.0), 3.0);                       // the camera looks down -z
      col += vec3(0.10, 0.26, 0.85) * rim * (0.12 + 0.88 * l) * 0.55;
      vec3 h = normalize(uSun + vec3(0.0, 0.0, 1.0));
      col += vec3(0.45, 0.62, 1.0) * pow(max(dot(vN, h), 0.0), 80.0) * 0.22;   // sun glint on the sea
      gl_FragColor = vec4(col * uFade, 1.0);
    }`,
});

const dotsMat = new THREE.ShaderMaterial({
  uniforms: { ...shared, uSize: { value: 2.2 }, uPixelRatio: { value: 1 } },
  transparent: true, depthWrite: false,
  vertexShader: /* glsl */`
    uniform float uSize; uniform float uPixelRatio; uniform vec3 uSun;
    attribute float aIndia; attribute float aRand;
    varying float vLight; varying float vIndia; varying float vFacing; varying float vRand;
    void main() {
      vec3 n = normalize(mat3(modelMatrix) * position);
      vLight = max(dot(n, uSun), 0.0);
      vFacing = n.z;
      vIndia = aIndia; vRand = aRand;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = uSize * (1.0 + aIndia * 0.55) * (0.85 + 0.3 * aRand) * uPixelRatio * (6.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uFade;
    varying float vLight; varying float vIndia; varying float vFacing; varying float vRand;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.12, d) * smoothstep(0.0, 0.3, vFacing);
      vec3 col = mix(vec3(0.06, 0.09, 0.17), vec3(0.50, 0.60, 0.80), vLight) * (0.2 + 0.8 * vLight);
      if (vIndia > 0.5) {
        float p = 0.5 + 0.5 * sin(uTime * 2.2 + vRand * 6.28);
        col = vec3(0.40, 0.72, 1.6) * (0.9 + 0.45 * p);                 // > 1: bloom picks India up
      }
      gl_FragColor = vec4(col, a * uFade);
    }`,
});

const atmosMat = new THREE.ShaderMaterial({
  uniforms: shared, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    varying vec3 vN;
    void main() { vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSun; uniform float uFade;
    varying vec3 vN;
    void main() {
      float i = pow(clamp(-vN.z, 0.0, 1.0), 2.2);
      float lit = 0.35 + 0.65 * max(dot(normalize(vN.xy + 1e-4), normalize(uSun.xy)), 0.0);   // brighter on the sunlit limb
      gl_FragColor = vec4(vec3(0.12, 0.32, 1.0) * i * 0.9 * lit * uFade, 1.0);
    }`,
});

const beamMat = new THREE.ShaderMaterial({
  uniforms: shared, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uFade;
    varying vec2 vUv;
    void main() {
      float along = vUv.y;                                               // 1 at the satellite, 0 at India
      float pulse = 0.55 + 0.45 * sin(uTime * 4.0 + along * 14.0);
      float a = pow(along, 0.9) * 0.16 * pulse + smoothstep(0.06, 0.0, along) * 0.18;
      gl_FragColor = vec4(vec3(0.45, 0.72, 1.4) * a * uFade, 1.0);
    }`,
});

const pingMat = new THREE.ShaderMaterial({
  uniforms: shared, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uFade;
    varying vec2 vUv;
    void main() {
      float r = length(vUv - 0.5) * 2.0;
      float a = 0.0;
      for (int k = 0; k < 2; k++) {
        float f = fract(uTime * 0.55 + float(k) * 0.5);
        a += smoothstep(0.06, 0.0, abs(r - f)) * (1.0 - f);
      }
      gl_FragColor = vec4(vec3(0.35, 0.6, 1.3) * a * 0.7 * uFade, 1.0);
    }`,
});

const starMat = new THREE.ShaderMaterial({
  uniforms: { ...shared, uPixelRatio: { value: 1 } }, transparent: true, depthWrite: false,
  vertexShader: /* glsl */`
    uniform float uPixelRatio; attribute float aSize; attribute float aRand; varying float vRand;
    void main() { vRand = aRand; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uPixelRatio; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uFade; varying float vRand;
    void main() {
      float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
      float tw = 0.45 + 0.55 * sin(uTime * (0.6 + vRand) + vRand * 40.0);
      gl_FragColor = vec4(vec3(0.82, 0.88, 1.0), smoothstep(0.5, 0.0, d) * tw * 0.75 * uFade);
    }`,
});

const satMat = new THREE.ShaderMaterial({
  uniforms: { ...shared, uPixelRatio: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    uniform float uPixelRatio;
    void main() { gl_PointSize = 34.0 * uPixelRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uFade;
    void main() {
      vec2 c = gl_PointCoord - 0.5; float d = length(c);
      float core = smoothstep(0.09, 0.0, d);
      float halo = smoothstep(0.5, 0.0, d) * 0.35;
      float flare = (smoothstep(0.015, 0.0, abs(c.x)) + smoothstep(0.015, 0.0, abs(c.y))) * smoothstep(0.5, 0.0, d) * 0.6;
      gl_FragColor = vec4(vec3(0.75, 0.88, 1.6) * (core * 2.5 + halo + flare) * uFade, 1.0);
    }`,
});

function useLandDots() {
  const geom = useMemo(() => new THREE.BufferGeometry(), []);
  useEffect(() => {
    let alive = true;
    fetch("/land-dots.json").then((r) => r.json()).then((flat) => {
      if (!alive) return;
      const n = flat.length / 3;
      const pos = new Float32Array(n * 3), india = new Float32Array(n), rand = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        toXYZ(flat[3 * i + 1], flat[3 * i], 1.004).toArray(pos, 3 * i);
        india[i] = flat[3 * i + 2]; rand[i] = Math.random();
      }
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geom.setAttribute("aIndia", new THREE.BufferAttribute(india, 1));
      geom.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
      geom.computeBoundingSphere();
    }).catch(() => {});
    return () => { alive = false; };
  }, [geom]);
  return geom;
}

function graticule() {
  const pts = [];
  const seg = (a, b) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = 0; lon < 360; lon += 4) seg(toXYZ(lat, lon, 1.002), toXYZ(lat, lon + 4, 1.002));
  for (let lon = 0; lon < 360; lon += 30) for (let lat = -88; lat < 88; lat += 4) seg(toXYZ(lat, lon, 1.002), toXYZ(lat + 4, lon, 1.002));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: "#7fa6ff", transparent: true, opacity: 0.07, depthWrite: false }));
}

function orbitRing() {
  const pts = [];
  for (let k = 0; k <= 256; k++) { const a = (k / 256) * Math.PI * 2; pts.push(new THREE.Vector3(Math.sin(a) * ORBIT, 0, Math.cos(a) * ORBIT)); }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: "#9cc4ff", dashSize: 0.035, gapSize: 0.055, transparent: true, opacity: 0.4, depthWrite: false }));
  line.computeLineDistances();
  return line;
}

/** A cone from the satellite down to India, open at both ends, uv.y = 1 at the satellite. */
function beamMesh(from, to) {
  const len = from.distanceTo(to);
  const g = new THREE.CylinderGeometry(0.006, 0.17, len, 48, 1, true);
  g.translate(0, len / 2, 0);                                            // base (India) at the origin
  const m = new THREE.Mesh(g, beamMat);
  m.position.copy(to);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), from.clone().sub(to).normalize());
  return m;
}

function stars() {
  const n = 1600, pos = new Float32Array(n * 3), size = new Float32Array(n), rand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(30 + Math.random() * 30);
    v.toArray(pos, 3 * i);
    size[i] = Math.random() < 0.06 ? 2.6 : 0.8 + Math.random() * 1.2; rand[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  g.setAttribute("aRand", new THREE.BufferAttribute(rand, 1));
  return new THREE.Points(g, starMat);
}

function Earth({ slot, leaving }) {
  const { size, camera, gl } = useThree();
  const place = useRef(null), spin = useRef(null), sky = useRef(null);
  const dots = useLandDots();
  const leaveAt = useRef(null);
  const objects = useMemo(() => {
    const india = toXYZ(INDIA.lat, INDIA.lon, 1.0);
    const sat = toXYZ(0, INSAT_LON, ORBIT);
    const ping = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), pingMat);
    ping.position.copy(toXYZ(INDIA.lat, INDIA.lon, 1.008));
    ping.lookAt(toXYZ(INDIA.lat, INDIA.lon, 3));
    const satPoint = new THREE.Points(new THREE.BufferGeometry().setFromPoints([sat]), satMat);
    return { grid: graticule(), orbit: orbitRing(), beam: beamMesh(sat, india), ping, satPoint, stars: stars() };
  }, []);

  useEffect(() => {
    const pr = gl.getPixelRatio();
    dotsMat.uniforms.uPixelRatio.value = pr; starMat.uniforms.uPixelRatio.value = pr; satMat.uniforms.uPixelRatio.value = pr;
  }, [gl, size]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    shared.uTime.value = t;
    const intro = REDUCED ? 1 : easeOut(t / 1.8);
    shared.uFade.value = intro;

    // Fit the globe (radius 1) to the layout's .globe-slot: camera fixed on +z, the planet moves
    const b = slot.current?.getBoundingClientRect();
    const W = size.width, H = size.height;
    const rPx = b ? b.width / 2 : Math.min(W, H) * 0.26;
    const cx = b ? b.left + b.width / 2 : W / 2, cy = b ? b.top + b.height / 2 : H * 0.42;
    const halfH = H / (2 * rPx);                                          // world half-height when the globe spans rPx
    const dist = halfH / Math.tan((camera.fov * DEG) / 2);
    camera.position.set(0, 0, dist);
    camera.updateProjectionMatrix();
    const unit = (2 * halfH) / H;
    place.current.position.set((cx - W / 2) * unit, (H / 2 - cy) * unit, 0);

    // Spin eastward and settle with India facing us; dive toward it when the splash leaves
    if (leaving && leaveAt.current === null) leaveAt.current = t;
    const out = leaveAt.current === null ? 0 : easeOut((t - leaveAt.current) / 0.9);
    const s = (0.84 + 0.16 * intro) * (1 + 1.4 * out * out);
    place.current.scale.setScalar(s);
    const lon = INDIA.lon + (REDUCED ? 0 : 150 * Math.exp(-t / 1.15) - 2.2 * t);
    spin.current.rotation.y = -lon * DEG;
    sky.current.rotation.y += delta * 0.006;
  });

  return (
    <>
      <primitive ref={sky} object={objects.stars} />
      <group ref={place}>
        <group rotation={[TILT, 0, 0]}>
          <group ref={spin}>
            <mesh material={oceanMat}><sphereGeometry args={[1, 128, 128]} /></mesh>
            <primitive object={objects.grid} />
            <points geometry={dots} material={dotsMat} />
            <primitive object={objects.ping} />
            <primitive object={objects.orbit} />
            <primitive object={objects.beam} />
            <primitive object={objects.satPoint} />
          </group>
        </group>
        <mesh material={atmosMat} scale={1.2}><sphereGeometry args={[1, 96, 96]} /></mesh>
      </group>
    </>
  );
}

class Fallback extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Full-screen WebGL globe sized and placed by the `slot` element; bloom makes India and INSAT glow. */
export default function GlobeScene({ slot, leaving }) {
  return (
    <Fallback>
      <Canvas className="globe-canvas" style={{ position: "absolute", inset: 0 }} dpr={[1, 2]} camera={{ fov: 30, near: 0.1, far: 200, position: [0, 0, 8] }}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }} aria-hidden="true">
        <color attach="background" args={["#04060b"]} />
        <Earth slot={slot} leaving={leaving} />
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur luminanceThreshold={0.55} luminanceSmoothing={0.2} intensity={0.95} radius={0.7} />
          <Vignette offset={0.28} darkness={0.75} />
          <Noise opacity={0.028} />
        </EffectComposer>
      </Canvas>
    </Fallback>
  );
}
