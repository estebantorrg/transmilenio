/**
 * Bake the bus model pivot to the EXACT bottom-center of the wheels.
 *
 * Source: buscar.glb (Draco + webp, kept intact). We never touch the compressed
 * geometry — we read the POSITION accessor's min/max (mandatory in glTF even
 * under KHR_draco_mesh_compression), transform the bounding box by the node's
 * TRS into world space, then set the node translation so that:
 *   world centerX = 0,  world minY = 0 (wheels on ground),  world centerZ = 0
 *
 * Output: client/public/models/bus.glb  (pivot at bottom-center, NOT the front).
 *
 * Run: node scripts/bake-bus-pivot.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Usage: node bake-bus-pivot.mjs [srcRelToRepo] [outRelToRepo]
// Defaults bake the full model; pass args to bake the LOD too.
const SRC = path.resolve(__dirname, '..', process.argv[2] || 'buscar.glb');
const OUT = path.resolve(__dirname, '..', process.argv[3] || 'client/public/models/bus.glb');

function align4(n) { return (n + 3) & ~3; }

// quaternion (x,y,z,w) rotate vector
function qrot([x, y, z, w], [vx, vy, vz]) {
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

const glb = fs.readFileSync(SRC);
if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
const binChunkOff = 20 + jsonLen;
const binLen = glb.readUInt32LE(binChunkOff);
const bin = glb.subarray(binChunkOff + 8, binChunkOff + 8 + binLen);

// Root mesh node (scene has a single 'bus' node).
const rootIdx = json.scenes[json.scene ?? 0].nodes.find((i) => json.nodes[i].mesh != null);
const node = json.nodes[rootIdx];
const q = node.rotation || [0, 0, 0, 1];
const t0 = node.translation || [0, 0, 0];
const s = node.scale || [1, 1, 1];

// POSITION accessor of the (only) primitive.
const posAcc = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
const [lnx, lny, lnz] = posAcc.min;
const [lxx, lxy, lxz] = posAcc.max;

// Transform the 8 local-bbox corners into world space: T + R·(S·corner) — the
// node's full TRS, so a non-identity node scale still bakes the correct pivot.
let wmin = [Infinity, Infinity, Infinity];
let wmax = [-Infinity, -Infinity, -Infinity];
for (const cx of [lnx, lxx]) for (const cy of [lny, lxy]) for (const cz of [lnz, lxz]) {
  const r = qrot(q, [cx * s[0], cy * s[1], cz * s[2]]);
  for (let k = 0; k < 3; k++) {
    const v = t0[k] + r[k];
    wmin[k] = Math.min(wmin[k], v);
    wmax[k] = Math.max(wmax[k], v);
  }
}

// Shift so X,Z centered and Y bottom (minY) sits at 0.
const shift = [
  -(wmin[0] + wmax[0]) / 2,
  -wmin[1],
  -(wmin[2] + wmax[2]) / 2,
];
node.translation = [t0[0] + shift[0], t0[1] + shift[1], t0[2] + shift[2]];

console.log('world bbox  min', wmin.map((v) => +v.toFixed(4)), 'max', wmax.map((v) => +v.toFixed(4)));
console.log('size (m)    X', (wmax[0] - wmin[0]).toFixed(3), 'Y', (wmax[1] - wmin[1]).toFixed(3), 'Z', (wmax[2] - wmin[2]).toFixed(3));
console.log('pivot shift', shift.map((v) => +v.toFixed(5)));
console.log('node.translation =', node.translation.map((v) => +v.toFixed(5)));

// Re-emit the GLB (new JSON chunk, identical BIN).
const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
const binPad = align4(bin.length) - bin.length;
const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jh, jsonChunk, bh, binChunk]));
console.log('written', OUT, (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
