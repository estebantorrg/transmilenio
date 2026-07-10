/**
 * Refreshes the tullave recharge-point catalog (`data/recarga_points.json`).
 *
 * The upstream (`/puntos_recarga` on the CO-geofenced live host, spec §5.8) is
 * static POI data that rarely changes, so — like the master catalog — we fetch
 * it once from a Colombian egress and commit the result. Production (Render, US)
 * then serves the committed file with zero runtime geofence dependency.
 *
 * Run from a Colombian network: `npm run sync:recarga`.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIVE_HOST = 'tmsa-transmiapp-shvpc.uc.r.appspot.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data', 'recarga_points.json');

export interface RechargePoint {
  nombre: string;
  direccion: string;
  localidad: string;
  latitud: number;
  longitud: number;
  hds?: string; // holiday hours ("HH:MM-HH:MM")
  exs?: string; // saturday hours
  wks?: string; // weekday hours
}

function clean(raw: any): RechargePoint | null {
  const lat = Number(raw?.latitud);
  const lng = Number(raw?.longitud);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) return null;
  const nombre = String(raw?.nombre ?? '').trim();
  if (!nombre) return null;
  return {
    nombre,
    direccion: String(raw?.direccion ?? '').trim(),
    localidad: String(raw?.localidad ?? '').trim(),
    latitud: lat,
    longitud: lng,
    hds: raw?.hds ? String(raw.hds) : undefined,
    exs: raw?.exs ? String(raw.exs) : undefined,
    wks: raw?.wks ? String(raw.wks) : undefined,
  };
}

export async function syncRechargePoints(): Promise<number> {
  const res = await fetch(`https://${LIVE_HOST}/puntos_recarga`, {
    headers: {
      Appid: '9a2c3b48f0c24ae9bfba38e94f27c3ea',
      'User-Agent': 'okhttp/4.12.0',
      uuid: 'fd1be953-d85e-4c63-8c23-234f143f445d',
      version: '2.9.5',
    },
  });
  if (!res.ok) throw new Error(`puntos_recarga HTTP ${res.status} (need a Colombian egress IP)`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('puntos_recarga did not return an array');

  const points = raw.map(clean).filter((p): p is RechargePoint => p !== null);
  await writeFile(OUT, JSON.stringify(points), 'utf8');
  return points.length;
}

// Run directly (not when imported). Sets `exitCode` instead of calling
// `process.exit()` — a hard exit races libuv handle teardown on Windows
// (assertion in async.c) while the undici pool is still closing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncRechargePoints()
    .then((n) => {
      console.log(`[sync:recarga] Wrote ${n} recharge points to ${OUT}`);
    })
    .catch((err) => {
      console.error('[sync:recarga] Failed:', err?.message || err);
      process.exitCode = 1;
    });
}
