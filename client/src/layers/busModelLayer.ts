/**
 * 3D Bus Model Layer
 *
 * Renders `bus.glb` (Draco + webp, pivot baked to bottom-center of the wheels)
 * for every live bus, in a single MapLibre custom WebGL layer via three.js.
 * One model is used for ALL bus types (troncal / zonal / alimentador).
 *
 * The model pivot is the bottom-center, so positioning a clone at a bus's
 * MercatorCoordinate (altitude 0) plants the wheels on the ground at that
 * lng/lat — never offset to the front of the bus.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import maplibregl from 'maplibre-gl';

const MODEL_URL = '/models/bus.glb';
const DRACO_PATH = '/draco/';

// Tunables ───────────────────────────────────────────────────────────────────
const MODEL_SCALE = 4;            // visual size multiplier over true meters
const BASE_TILT = Math.PI / 2;    // glTF is Y-up; MapLibre mercator is Z-up
const HEADING_OFFSET_DEG = 180;   // calibrate so the nose points along travel
const HEADING_SIGN = -1;          // flip if the model faces backwards
const MOVE_LERP = 0.12;           // position smoothing per frame
const TURN_LERP = 0.18;           // heading smoothing per frame
const DEG2RAD = Math.PI / 180;

export interface LiveBusInput {
  id: string;
  lng: number;
  lat: number;
  heading?: number; // degrees (compass bearing from `angulo`)
}

interface BusObj {
  group: THREE.Group;
  cur: { x: number; y: number; z: number; rot: number };
  target: { x: number; y: number; z: number; rot: number };
}

const LAYER_ID = 'live-bus-models';

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.Camera | null = null;
let template: THREE.Object3D | null = null;
let modelLoading = false;
const buses = new Map<string, BusObj>();
let mapRef: maplibregl.Map | null = null;

function shortestAngleLerp(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** MapLibre mercator rotation about up (+Z) from a compass bearing. */
function headingToRot(headingDeg: number): number {
  return (HEADING_SIGN * headingDeg + HEADING_OFFSET_DEG) * DEG2RAD;
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
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(0.4, -0.7, 1.0);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6);
    fill.position.set(-0.5, 0.6, 0.4);
    scene.add(fill);

    renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGLRenderingContext, antialias: true });
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    if (!template && !modelLoading) {
      modelLoading = true;
      const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
      const loader = new GLTFLoader().setDRACOLoader(draco);
      loader.load(
        MODEL_URL,
        (gltf) => {
          template = gltf.scene;
          modelLoading = false;
          // Fill in buses queued before the model finished loading.
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
    if (!renderer || !scene || !camera) return;
    const m = (Array.isArray(matrix) ? matrix : (matrix as any)?.defaultProjectionData?.mainMatrix) as number[] | undefined;
    if (!m) return;

    let animating = false;
    for (const [, b] of buses) {
      b.cur.x += (b.target.x - b.cur.x) * MOVE_LERP;
      b.cur.y += (b.target.y - b.cur.y) * MOVE_LERP;
      b.cur.z += (b.target.z - b.cur.z) * MOVE_LERP;
      b.cur.rot = shortestAngleLerp(b.cur.rot, b.target.rot, TURN_LERP);
      if (Math.hypot(b.target.x - b.cur.x, b.target.y - b.cur.y) > 1e-9) animating = true;

      b.group.position.set(b.cur.x, b.cur.y, b.cur.z);
      b.group.rotation.z = b.cur.rot;
    }

    camera.projectionMatrix = new THREE.Matrix4().fromArray(m);
    renderer.resetState();
    renderer.render(scene, camera);
    if (animating) mapRef?.triggerRepaint();
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
  // Add above everything so buses are not occluded by fills.
  map.addLayer(customLayer);
}

/** Reconcile the rendered bus set with the latest live positions. */
export function setBusModels(map: maplibregl.Map, input: LiveBusInput[]): void {
  ensureBusLayer(map);
  const seen = new Set<string>();

  for (const bus of input) {
    seen.add(bus.id);
    const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: bus.lng, lat: bus.lat }, 0);
    const meter = merc.meterInMercatorCoordinateUnits();
    const rot = headingToRot(bus.heading ?? 0);

    let obj = buses.get(bus.id);
    if (!obj) {
      const group = new THREE.Group();
      group.scale.setScalar(meter * MODEL_SCALE);
      if (template) group.add(buildInner());
      scene?.add(group);
      obj = { group, cur: { x: merc.x, y: merc.y, z: merc.z, rot }, target: { x: merc.x, y: merc.y, z: merc.z, rot } };
      buses.set(bus.id, obj);
    } else {
      obj.group.scale.setScalar(meter * MODEL_SCALE);
    }
    obj.target = { x: merc.x, y: merc.y, z: merc.z, rot };
  }

  // Drop buses that are no longer live.
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
