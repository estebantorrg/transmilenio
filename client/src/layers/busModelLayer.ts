/**
 * 3D Bus Model Layer
 *
 * Renders `bus.glb` (Draco + webp, pivot baked to bottom-center of the wheels)
 * for every live bus, in a single MapLibre custom WebGL layer via three.js.
 * One model is used for ALL bus types (troncal / zonal / alimentador).
 *
 * Motion: positions are tweened from the previous fix to the new one across the
 * poll interval, so buses glide continuously instead of snapping every 15 s.
 * Heading is derived from the travel direction; size adapts to zoom so buses
 * stay visible when zoomed out; rendering uses a per-frame local origin to avoid
 * mercator float-precision jitter while the map moves.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import maplibregl from 'maplibre-gl';

const MODEL_URL = '/models/bus.glb';
const DRACO_PATH = '/draco/';

// Tunables ───────────────────────────────────────────────────────────────────
const MODEL_SCALE = 5;            // size multiplier over true meters (close-up)
const SCALE_REF_ZOOM = 15;        // at/above this zoom, no extra boost
const MAX_ZOOM_BOOST = 64;        // cap on the zoomed-out enlargement
const POLL_MS = 15000;            // tween duration = live poll interval (§3.4)
const BASE_TILT = Math.PI / 2;    // glTF Y-up → MapLibre mercator Z-up
const HEADING_OFFSET_DEG = 180;   // fallback heading (stationary) from `angulo`
const HEADING_SIGN = -1;
const DEG2RAD = Math.PI / 180;

export interface LiveBusInput {
  id: string;
  lng: number;
  lat: number;
  heading?: number; // degrees (compass bearing from `angulo`)
}

interface Vec3 { x: number; y: number; z: number; }

interface BusObj {
  group: THREE.Group;
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
let template: THREE.Object3D | null = null;
let modelLoading = false;
const buses = new Map<string, BusObj>();
let mapRef: maplibregl.Map | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function shortestAngleLerp(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Fallback mercator rotation (about +Z) from a compass bearing, used only when a bus is stationary. */
function headingToRot(headingDeg: number): number {
  return (HEADING_SIGN * headingDeg + HEADING_OFFSET_DEG) * DEG2RAD;
}

/** Sample a bus's interpolated position + heading at time `now`. */
function sample(b: BusObj, now: number): { x: number; y: number; z: number; rot: number } {
  const t = clamp((now - b.start) / b.duration, 0, 1);
  return {
    x: b.from.x + (b.to.x - b.from.x) * t,
    y: b.from.y + (b.to.y - b.from.y) * t,
    z: b.from.z + (b.to.z - b.from.z) * t,
    rot: shortestAngleLerp(b.rotFrom, b.rotTo, t),
  };
}

function buildInner(): THREE.Object3D {
  const inner = (template as THREE.Object3D).clone(true);
  inner.rotation.x = BASE_TILT; // glTF Y-up → MapLibre mercator Z-up
  return inner;
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
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    if (!template && !modelLoading) {
      modelLoading = true;
      const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
      const loader = new GLTFLoader().setDRACOLoader(draco);
      loader.load(
        MODEL_URL,
        (gltf) => {
          template = gltf.scene;
          // Crisper texture at glancing map angles; reduces shimmer on move.
          template.traverse((o) => {
            const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
            if (mat && mat.map) { mat.map.anisotropy = maxAniso; mat.map.needsUpdate = true; }
          });
          modelLoading = false;
          for (const [, b] of buses) {
            if (b.group.children.length === 0) b.group.add(buildInner());
          }
          mapRef?.triggerRepaint();
        },
        undefined,
        (err) => { modelLoading = false; console.error('[BusModel] failed to load', MODEL_URL, err); }
      );
    }
  },

  render(_gl, matrix) {
    if (!renderer || !scene || !camera || !mapRef) return;
    const m = (Array.isArray(matrix) ? matrix : (matrix as any)?.defaultProjectionData?.mainMatrix) as number[] | undefined;
    if (!m) return;

    const now = performance.now();
    // Local origin (map centre) keeps object coordinates small → no float jitter.
    const origin = maplibregl.MercatorCoordinate.fromLngLat(mapRef.getCenter(), 0);
    const boost = clamp(Math.pow(2, SCALE_REF_ZOOM - mapRef.getZoom()), 1, MAX_ZOOM_BOOST);

    for (const [, b] of buses) {
      const s = sample(b, now);
      b.group.position.set(s.x - origin.x, s.y - origin.y, s.z - origin.z);
      b.group.rotation.z = s.rot;
      b.group.scale.setScalar(b.meter * MODEL_SCALE * boost);
    }

    camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(m)
      .multiply(new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z));
    renderer.resetState();
    renderer.render(scene, camera);

    // Keep animating while any bus is on screen (drives the tween between polls).
    if (buses.size > 0) mapRef.triggerRepaint();
  },

  onRemove() {
    for (const [, b] of buses) scene?.remove(b.group);
    buses.clear();
    renderer?.dispose();
    renderer = null; scene = null; camera = null;
  },
};

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
    const providedRot = headingToRot(bus.heading ?? 0);

    let obj = buses.get(bus.id);
    if (!obj) {
      const group = new THREE.Group();
      if (template) group.add(buildInner());
      scene?.add(group);
      obj = { group, from: to, to, rotFrom: providedRot, rotTo: providedRot, start: now, duration: POLL_MS, meter };
      buses.set(bus.id, obj);
      continue;
    }

    // Tween from where the bus currently *is* (mid-interpolation) to the new fix.
    const cur = sample(obj, now);
    const dx = to.x - cur.x;
    const dy = to.y - cur.y;
    const moved = Math.hypot(dx, dy) > meter * 3; // > ~3 m
    obj.from = { x: cur.x, y: cur.y, z: cur.z };
    obj.to = to;
    obj.rotFrom = cur.rot;
    // Face the travel direction; keep prior heading when essentially stationary.
    obj.rotTo = moved ? Math.atan2(dx, -dy) : cur.rot;
    obj.start = now;
    obj.duration = POLL_MS;
    obj.meter = meter;
  }

  for (const [id, obj] of buses) {
    if (!seen.has(id)) {
      scene?.remove(obj.group);
      buses.delete(id);
    }
  }

  map.triggerRepaint();
}

export function clearBusModels(map: maplibregl.Map): void {
  for (const [, obj] of buses) scene?.remove(obj.group);
  buses.clear();
  map.triggerRepaint();
}
