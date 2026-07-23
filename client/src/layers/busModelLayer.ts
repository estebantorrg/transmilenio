/**
 * 3D Bus Model Layer
 *
 * Renders every live bus as a 3D model in one MapLibre custom WebGL layer
 * (three.js). One model family is used for ALL bus types.
 *
 * - LOD: a light model (`bus_lod.glb`) loads immediately and is shown when
 *   zoomed out; the full model (`bus.glb`) is lazy-loaded the first time the
 *   user zooms in past `LOD_ZOOM` and shown from then on at close range.
 * - Motion: positions tween from the previous fix to the new one across the
 *   poll interval (glide, no snapping); heading uses the telemetry `angulo`.
 * - Declump: buses sharing a spot are fanned out in a small ring so they don't
 *   stack into one blob.
 * - Precision: rendered relative to a per-frame local origin (no mercator jitter).
 * - Follow: the open popup tracks its bus every frame via `setFollow`.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import maplibregl from 'maplibre-gl';

const MODEL_URL_LOD = '/models/bus_lod.glb';
const MODEL_URL_FULL = '/models/bus.glb';
const DRACO_PATH = '/draco/';

// Tunables ───────────────────────────────────────────────────────────────────
const MODEL_SCALE = 5;            // size multiplier over true meters (close-up)
const SCALE_REF_ZOOM = 15;        // at/above this zoom, no extra boost
const MAX_ZOOM_BOOST = 64;        // cap on the zoomed-out enlargement
const LOD_ZOOM = 15.5;            // ≥ this → full model; below → LOD
const POLL_MS = 15000;            // tween duration = live poll interval (§3.4)
const BASE_TILT = Math.PI / 2;    // glTF Y-up → MapLibre mercator Z-up
// `angulo` is a compass bearing (0=N, clockwise) — verified against motion.
const HEADING_OFFSET_DEG = 0;
const HEADING_SIGN = 1;
const DEG2RAD = Math.PI / 180;
const DECLUMP_RING = 0.62;        // fan radius as a fraction of the model footprint

export interface LiveBusInput {
  id: string;
  lng: number;
  lat: number;
  heading?: number; // degrees (compass bearing from `angulo`)
}

interface Vec3 { x: number; y: number; z: number; }

interface BusObj {
  group: THREE.Group;
  lod?: THREE.Object3D;
  full?: THREE.Object3D;
  from: Vec3;
  to: Vec3;
  rotFrom: number;
  rotTo: number;
  start: number;    // performance.now() ms
  duration: number; // ms
  meter: number;    // mercator units per metre at this bus's latitude
}

const LAYER_ID = 'live-bus-models';

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.Camera | null = null;
let maxAniso = 1;
let templateLOD: THREE.Object3D | null = null;
let templateFull: THREE.Object3D | null = null;
let lodLoading = false;
let fullLoading = false;
const buses = new Map<string, BusObj>();
// Last rendered position per bus (interpolated tween + declump offset, in
// mercator units). Click-picking reads this so a moving bus is hit-tested at
// where it is actually drawn, not at its stale last-fix coordinate.
const renderedMerc = new Map<string, Vec3>();
let mapRef: maplibregl.Map | null = null;

let followId: string | null = null;
let followCb: ((lngLat: { lng: number; lat: number }) => void) | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function shortestAngleLerp(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function headingToRot(headingDeg: number): number {
  return (HEADING_SIGN * headingDeg + HEADING_OFFSET_DEG) * DEG2RAD;
}

function sample(b: BusObj, now: number): { x: number; y: number; z: number; rot: number } {
  const t = clamp((now - b.start) / b.duration, 0, 1);
  return {
    x: b.from.x + (b.to.x - b.from.x) * t,
    y: b.from.y + (b.to.y - b.from.y) * t,
    z: b.from.z + (b.to.z - b.from.z) * t,
    rot: shortestAngleLerp(b.rotFrom, b.rotTo, t),
  };
}

/** Force the model opaque (no see-through) + crisp texture. One material covers the bus. */
function prepModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      mat.transparent = false;
      mat.depthWrite = true;
      mat.depthTest = true;
      mat.opacity = 1;
      mat.alphaTest = 0;
      if (mat.map) mat.map.anisotropy = maxAniso;
      mat.needsUpdate = true;
    }
  });
}

function tilted(template: THREE.Object3D): THREE.Object3D {
  const o = template.clone(true);
  o.rotation.x = BASE_TILT; // glTF Y-up → mercator Z-up
  return o;
}

/** Attach whichever model templates are ready to a bus group (idempotent). */
function attachModels(b: BusObj): void {
  if (templateLOD && !b.lod) {
    b.lod = tilted(templateLOD);
    b.group.add(b.lod);
  }
  if (templateFull && !b.full) {
    b.full = tilted(templateFull);
    b.full.visible = false;
    b.group.add(b.full);
  }
}

function loadModel(url: string, onReady: (obj: THREE.Object3D) => void): void {
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  loader.load(
    url,
    (gltf) => { prepModel(gltf.scene); onReady(gltf.scene); mapRef?.triggerRepaint(); },
    undefined,
    (err) => console.error('[BusModel] failed to load', url, err)
  );
}

/**
 * Fetch + Draco-decode the LOD model ahead of the first tracked bus. Without
 * this the download only starts when the layer is added — i.e. AFTER the first
 * live fix has landed — so the buses appear a model-load later than the data.
 * Idempotent and safe to call before any map exists.
 */
export function preloadBusModels(): void {
  if (templateLOD || lodLoading) return;
  lodLoading = true;
  loadModel(MODEL_URL_LOD, (obj) => {
    templateLOD = obj;
    lodLoading = false;
    for (const [, b] of buses) attachModels(b);
  });
}

const customLayer: maplibregl.CustomLayerInterface = {
  id: LAYER_ID,
  type: 'custom',
  renderingMode: '3d',

  onAdd(map, gl) {
    camera = new THREE.Camera();
    scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(0.4, -0.7, 1.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6);
    fill.position.set(-0.5, 0.6, 0.4);
    scene.add(fill);

    renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGLRenderingContext, antialias: true });
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    maxAniso = renderer.capabilities.getMaxAnisotropy();

    // Load the lightweight LOD immediately; the full model is lazy (see render()).
    preloadBusModels();
  },

  render(_gl, matrix) {
    if (!renderer || !scene || !camera || !mapRef) return;
    const m = (Array.isArray(matrix) ? matrix : (matrix as any)?.defaultProjectionData?.mainMatrix) as number[] | undefined;
    if (!m) return;

    const now = performance.now();
    const zoom = mapRef.getZoom();
    const origin = maplibregl.MercatorCoordinate.fromLngLat(mapRef.getCenter(), 0);
    const boost = clamp(Math.pow(2, SCALE_REF_ZOOM - zoom), 1, MAX_ZOOM_BOOST);

    // Lazy-load the full model the first time the user is zoomed in close.
    if (zoom >= LOD_ZOOM && !templateFull && !fullLoading) {
      fullLoading = true;
      loadModel(MODEL_URL_FULL, (obj) => { templateFull = obj; fullLoading = false; for (const [, b] of buses) attachModels(b); });
    }
    const useFull = zoom >= LOD_ZOOM && !!templateFull;

    // Sample all buses, then declump any that share a spot.
    const entries = [...buses.entries()];
    const states = entries.map(([id, b]) => ({ id, b, s: sample(b, now), ox: 0, oy: 0, scale: b.meter * MODEL_SCALE * boost }));
    declump(states);

    for (const st of states) {
      const { b, s } = st;
      b.group.position.set(s.x + st.ox - origin.x, s.y + st.oy - origin.y, s.z - origin.z);
      b.group.rotation.z = s.rot;
      b.group.scale.setScalar(st.scale);
      if (b.lod) b.lod.visible = !useFull;
      if (b.full) b.full.visible = useFull;
      // Cache the actual drawn position (incl. declump) for click-picking.
      renderedMerc.set(st.id, { x: s.x + st.ox, y: s.y + st.oy, z: s.z });
    }

    // Keep the open popup glued to its bus (declumped position included).
    if (followId && followCb) {
      const st = states.find((x) => x.id === followId);
      if (st) followCb(new maplibregl.MercatorCoordinate(st.s.x + st.ox, st.s.y + st.oy, st.s.z).toLngLat());
    }

    camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(m)
      .multiply(new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z));
    renderer.resetState();
    renderer.render(scene, camera);

    if (buses.size > 0) mapRef.triggerRepaint();
  },

  onRemove() {
    for (const [, b] of buses) scene?.remove(b.group);
    buses.clear();
    renderedMerc.clear();
    renderer?.dispose();
    renderer = null; scene = null; camera = null;
  },
};

/** Fan out buses that overlap so a cluster doesn't render as one blob. */
function declump(states: Array<{ b: BusObj; s: { x: number; y: number; z: number; rot: number }; ox: number; oy: number; scale: number }>): void {
  const used = new Array(states.length).fill(false);
  for (let i = 0; i < states.length; i++) {
    if (used[i]) continue;
    const cluster = [i];
    used[i] = true;
    const reach = states[i].scale; // ~ model footprint in mercator units
    for (let j = i + 1; j < states.length; j++) {
      if (used[j]) continue;
      const dx = states[j].s.x - states[i].s.x;
      const dy = states[j].s.y - states[i].s.y;
      if (Math.hypot(dx, dy) < reach) { cluster.push(j); used[j] = true; }
    }
    if (cluster.length < 2) continue;
    const r = reach * DECLUMP_RING;
    cluster.forEach((idx, k) => {
      const a = (k / cluster.length) * Math.PI * 2;
      states[idx].ox = Math.cos(a) * r;
      states[idx].oy = Math.sin(a) * r;
    });
  }
}

export function ensureBusLayer(map: maplibregl.Map): void {
  mapRef = map;
  if (map.getLayer(LAYER_ID)) return;
  map.addLayer(customLayer);
}

/** Reconcile the rendered bus set with the latest live positions, starting a new tween. */
export function setBusModels(map: maplibregl.Map, input: LiveBusInput[]): void {
  ensureBusLayer(map);
  const now = performance.now();
  const seen = new Set<string>();

  for (const bus of input) {
    seen.add(bus.id);
    const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: bus.lng, lat: bus.lat }, 0);
    const meter = merc.meterInMercatorCoordinateUnits();
    const to: Vec3 = { x: merc.x, y: merc.y, z: merc.z };
    const hasHeading = bus.heading != null && Number.isFinite(bus.heading);
    const providedRot = hasHeading ? headingToRot(bus.heading as number) : null;

    let obj = buses.get(bus.id);
    if (!obj) {
      const group = new THREE.Group();
      const r0 = providedRot ?? 0;
      obj = { group, from: to, to, rotFrom: r0, rotTo: r0, start: now, duration: POLL_MS, meter };
      attachModels(obj);
      scene?.add(group);
      buses.set(bus.id, obj);
      continue;
    }

    const cur = sample(obj, now);
    const dx = to.x - cur.x;
    const dy = to.y - cur.y;
    obj.from = { x: cur.x, y: cur.y, z: cur.z };
    obj.to = to;
    obj.rotFrom = cur.rot;
    const moved = Math.hypot(dx, dy) > meter * 3; // > ~3 m
    obj.rotTo = providedRot != null ? providedRot : (moved ? Math.atan2(dx, -dy) : cur.rot);
    obj.start = now;
    obj.duration = POLL_MS;
    obj.meter = meter;
  }

  for (const [id, obj] of buses) {
    if (!seen.has(id)) {
      scene?.remove(obj.group);
      buses.delete(id);
      renderedMerc.delete(id);
    }
  }

  map.triggerRepaint();
}

/**
 * Current rendered position of a bus (interpolated tween + declump offset), as
 * lng/lat — or null if it isn't on screen yet. Used for click hit-testing so a
 * moving bus is picked where it's drawn, not at its stale last-fix coordinate.
 */
export function getRenderedBusLngLat(id: string): { lng: number; lat: number } | null {
  const m = renderedMerc.get(id);
  if (!m) return null;
  const ll = new maplibregl.MercatorCoordinate(m.x, m.y, m.z).toLngLat();
  return { lng: ll.lng, lat: ll.lat };
}

/** Make the open popup track a bus every frame; pass (null, null) to stop. */
export function setFollow(id: string | null, cb: ((lngLat: { lng: number; lat: number }) => void) | null): void {
  followId = id;
  followCb = cb;
}

export function clearBusModels(map: maplibregl.Map): void {
  for (const [, obj] of buses) scene?.remove(obj.group);
  buses.clear();
  renderedMerc.clear();
  followId = null;
  followCb = null;
  map.triggerRepaint();
}
