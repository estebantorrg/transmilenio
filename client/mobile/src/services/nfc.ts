/**
 * NFC card reading.
 *
 * Three backends, runtime-detected so the web bundle keeps NO hard dependency
 * (same pattern as `nativeLive.ts`). Inside the Android APK a native plugin is
 * MANDATORY — the System WebView disables Web NFC (`NDEFReader` throws "NFC
 * permission request denied"). Tried in order:
 *   1. `phonegap-nfc` (free/MIT) — global `window.nfc`. Recommended:
 *      `npm i phonegap-nfc && npx cap sync android` in `mobile/`.
 *   2. `@capawesome-team/capacitor-nfc` (`Capacitor.Plugins.Nfc`, sponsorware).
 *   3. Web NFC (`NDEFReader`) — only outside the APK, where the browser grants it.
 * No code import is needed for (1)/(2); see spec §5.5.1a.
 *
 * Honesty (spec §5.5.1a): the tullave card is an encrypted MIFARE DESFire whose
 * balance sits in a key-protected file we CANNOT read. NFC yields only the tag
 * serial (UID) and any NDEF records — surfaced as `source:"card"`, never a
 * verified balance.
 */

export interface NfcCardRead {
  serialNumber?: string;
  records: { type: string; text: string }[];
  numericId?: string;
}

interface NativeNfcPlugin {
  isSupported?: () => Promise<{ supported?: boolean; isSupported?: boolean }>;
  isEnabled?: () => Promise<{ enabled?: boolean; isEnabled?: boolean }>;
  requestPermissions?: () => Promise<unknown>;
  startScanSession: (options?: unknown) => Promise<void>;
  stopScanSession: (options?: unknown) => Promise<void>;
  addListener: (event: string, cb: (e: any) => void) => Promise<{ remove: () => Promise<void> }>;
}

function getNativeNfc(): NativeNfcPlugin | null {
  const cap = (window as any).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  const nfc = cap.Plugins?.Nfc;
  return nfc && typeof nfc.startScanSession === 'function' ? (nfc as NativeNfcPlugin) : null;
}

/** phonegap-nfc (free, MIT) exposes a global `window.nfc` with Cordova-style listeners.
 *  It also exposes raw ISO-DEP `connect`/`transceive`/`close` — used for the tullave
 *  Calypso balance read (spec §5.5.1b). */
interface PhonegapNfc {
  addTagDiscoveredListener: (cb: (e: any) => void, ok?: () => void, err?: (e: any) => void) => void;
  removeTagDiscoveredListener: (cb: (e: any) => void, ok?: () => void, err?: (e: any) => void) => void;
  // Promise-based in phonegap-nfc 1.x: connect(tech, timeout?) / transceive(data) → ArrayBuffer / close().
  connect?: (tech: string, timeout?: number) => Promise<void>;
  transceive?: (data: ArrayBuffer | Uint8Array | string) => Promise<ArrayBuffer>;
  close?: () => Promise<void>;
}
function getPhonegapNfc(): PhonegapNfc | null {
  const nfc = (window as any).nfc;
  return nfc && typeof nfc.addTagDiscoveredListener === 'function' ? (nfc as PhonegapNfc) : null;
}

export function isNfcSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    (getNativeNfc() !== null || getPhonegapNfc() !== null || 'NDEFReader' in window)
  );
}

// ─── byte helpers ────────────────────────────────────────
function bytesToHex(bytes: number[] | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join(':').toUpperCase();
}

/** Decode one capawesome NdefRecord (payload is a raw byte array). */
function decodeNativeRecord(rec: any): { type: string; text: string } | null {
  const payload: number[] = Array.isArray(rec?.payload) ? rec.payload : [];
  const type: number[] = Array.isArray(rec?.type) ? rec.type : [];
  if (payload.length === 0) return null;
  try {
    // Well-known Text record ('T' = 0x54): [status, lang…, text…]. Low 6 bits of
    // the status byte are the language-code length.
    if (type[0] === 0x54) {
      const langLen = payload[0] & 0x3f;
      const text = new TextDecoder('utf-8').decode(new Uint8Array(payload.slice(1 + langLen)));
      return { type: 'text', text };
    }
    if (type[0] === 0x55) {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(payload.slice(1)));
      return { type: 'url', text };
    }
    const text = new TextDecoder('utf-8').decode(new Uint8Array(payload));
    return { type: 'ndef', text: text.replace(/[^\x20-\x7e]/g, '').trim() };
  } catch {
    return null;
  }
}

function toResult(serialNumber: string | undefined, records: { type: string; text: string }[]): NfcCardRead {
  const digits = records.map((r) => r.text).join(' ').replace(/\D/g, '');
  return { serialNumber, records, numericId: digits.length >= 10 ? digits : undefined };
}

// ─── native path (capawesome) ───────────────────────────
async function scanNative(nfc: NativeNfcPlugin, signal?: AbortSignal): Promise<NfcCardRead> {
  // Plugin versions report under either key; coalesce so a single-key `false`
  // (e.g. `{ supported: false }`) still trips the guard.
  const sup = await nfc.isSupported?.().catch(() => undefined);
  if (sup && (sup.supported ?? sup.isSupported) === false) {
    throw new Error('Este teléfono no tiene NFC');
  }
  const en = await nfc.isEnabled?.().catch(() => undefined);
  if (en && (en.enabled ?? en.isEnabled) === false) {
    throw new Error('Activa el NFC en los ajustes del teléfono');
  }
  await nfc.requestPermissions?.().catch(() => undefined);

  return new Promise<NfcCardRead>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null;
    let settled = false;
    const cleanup = () => {
      void nfc.stopScanSession().catch(() => undefined);
      void handle?.remove().catch(() => undefined);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    nfc
      .addListener('nfcTagScanned', (event: any) => {
        const tag = event?.nfcTag ?? event;
        const records: { type: string; text: string }[] = [];
        for (const rec of tag?.message?.records ?? []) {
          const decoded = decodeNativeRecord(rec);
          if (decoded && decoded.text) records.push(decoded);
        }
        finish(() => resolve(toResult(bytesToHex(tag?.id), records)));
      })
      .then((h) => {
        handle = h;
        if (settled) cleanup();
        return nfc.startScanSession();
      })
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error('No se pudo iniciar el NFC'))));

    signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Lectura cancelada', 'AbortError'))));
  });
}

// ─── native path (phonegap-nfc, free) ──────────────────
function scanPhonegap(nfc: PhonegapNfc, signal?: AbortSignal): Promise<NfcCardRead> {
  return new Promise<NfcCardRead>((resolve, reject) => {
    let settled = false;
    const onTag = (event: any) => {
      const tag = event?.tag ?? event;
      const records: { type: string; text: string }[] = [];
      for (const rec of tag?.ndefMessage ?? []) {
        const decoded = decodeNativeRecord(rec);
        if (decoded && decoded.text) records.push(decoded);
      }
      finish(() => resolve(toResult(bytesToHex(tag?.id), records)));
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        nfc.removeTagDiscoveredListener(onTag);
      } catch {
        /* ignore */
      }
      fn();
    };
    nfc.addTagDiscoveredListener(
      onTag,
      undefined,
      (err: any) => finish(() => reject(new Error(`NFC no disponible: ${err ?? ''}`.trim())))
    );
    signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Lectura cancelada', 'AbortError'))));
  });
}

// ─── web path (NDEFReader) ──────────────────────────────
function scanWeb(signal?: AbortSignal): Promise<NfcCardRead> {
  const Reader = (window as any).NDEFReader;
  const reader = new Reader();
  return new Promise<NfcCardRead>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    reader.onreading = (event: any) => {
      const records: { type: string; text: string }[] = [];
      for (const rec of event.message?.records ?? []) {
        try {
          if (rec.recordType === 'text' || rec.recordType === 'url') {
            records.push({ type: rec.recordType, text: new TextDecoder(rec.encoding || 'utf-8').decode(rec.data) });
          }
        } catch {
          /* skip */
        }
      }
      done(() => resolve(toResult(event.serialNumber, records)));
    };
    reader.onreadingerror = () => done(() => reject(new Error('No se pudo leer la tarjeta. Inténtalo de nuevo.')));
    reader
      .scan(signal ? { signal } : undefined)
      .catch((err: any) =>
        done(() =>
          reject(
            new Error(
              /denied/i.test(String(err?.message))
                ? 'El sistema no permitió el NFC web. En la app instalada usa el lector NFC nativo.'
                : err instanceof Error
                  ? err.message
                  : 'NFC no permitido'
            )
          )
        )
      );
    signal?.addEventListener('abort', () => done(() => reject(new DOMException('Lectura cancelada', 'AbortError'))));
  });
}

// ─── tullave Calypso balance read (spec §5.5.1b) ─────────
// The card is a Calypso chip readable with plain, unauthenticated ISO-7816 APDUs
// (decoded from the official app v2.9.6 + validated live). Only phonegap-nfc
// exposes raw `transceive`, so this path needs that plugin inside the APK.

export interface NfcMovement {
  type: string;
  amountCOP?: number;
  finalBalanceCOP?: number;
  occurredAt?: string; // "DD/MM/YYYY HH:MM:SS"
}
export interface NfcBalanceRead {
  numeroTarjeta: string;
  balanceCOP: number;
  movements: NfcMovement[];
}

const APDU_SELECT_AID = [0x00, 0xa4, 0x04, 0x00, 0x07, 0xd4, 0x10, 0x00, 0x00, 0x03, 0x00, 0x01];
const APDU_BALANCE = [0x90, 0x4c, 0x00, 0x00, 0x04];
const APDU_READ_BINARY = [0x00, 0xb0, 0x86, 0x00, 0x42];
const APDU_SELECT_EF = [0x00, 0xa4, 0x00, 0x00, 0x02, 0x42, 0x00];
const apduRecord = (n: number) => [0x00, 0xb2, n & 0xff, 0x24, 0x2e];

/** True if the current plugin can do raw ISO-DEP transceive (Calypso read). */
export function canReadCardBalance(): boolean {
  const p = getPhonegapNfc();
  return !!(p && typeof p.transceive === 'function' && typeof p.connect === 'function');
}

/** Big-endian integer of arr[start,end), zero-padding out-of-range bytes
 *  (mirrors the official app's `getReversed(Arrays.copyOfRange(...))`). */
function beSlice(arr: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + (i < arr.length ? arr[i] : 0);
  return v;
}
function hexByte(b: number): string {
  return (b & 0xff).toString(16).padStart(2, '0');
}

function parseMovement(r: Uint8Array): NfcMovement | null {
  // A valid record ends in SW 9000 and carries a non-zero type byte.
  if (r.length < 33) return null;
  const t = r[0];
  if (t === 0) return null;
  const type =
    t === 0x01 ? 'Viaje en bus' : t === 0x02 ? 'Recarga de tarjeta' : t === 0x04 ? 'Cancelación recarga' : 'Movimiento';
  const finalBalanceCOP = beSlice(r, 3, 6);
  const amountCOP = beSlice(r, 11, 14);
  // Date/time bytes are BCD-hex (0x20 0x26 → "2026"); read the hex digits literally.
  const dd = hexByte(r[29]);
  const mm = hexByte(r[28]);
  const yyyy = hexByte(r[26]) + hexByte(r[27]);
  const hh = hexByte(r[30]);
  const mi = hexByte(r[31]);
  const ss = hexByte(r[32]);
  const occurredAt = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
  return { type, amountCOP, finalBalanceCOP, occurredAt };
}

/**
 * Read the tullave balance + last movements directly off the card via NFC.
 * Resolves a verified `source:"card"` balance (spec §5.5.1b). Rejects if the
 * transceive plugin is unavailable or the card doesn't answer — caller falls
 * back to the server ledger.
 */
export function readCardBalance(signal?: AbortSignal): Promise<NfcBalanceRead> {
  const nfc = getPhonegapNfc();
  if (!nfc || typeof nfc.transceive !== 'function' || typeof nfc.connect !== 'function') {
    return Promise.reject(new Error('La lectura de saldo por NFC requiere el plugin nativo (reconstruye el APK).'));
  }
  // phonegap-nfc's connect/transceive/close are Promise-based; transceive takes a
  // Uint8Array (or ArrayBuffer/hex string) and resolves with an ArrayBuffer.
  const connect = (tech: string) => nfc.connect!(tech, 5000);
  const transceive = async (data: number[]): Promise<Uint8Array> =>
    new Uint8Array(await nfc.transceive!(new Uint8Array(data)));
  const close = () => (nfc.close ? nfc.close() : Promise.resolve());

  return new Promise<NfcBalanceRead>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        nfc.removeTagDiscoveredListener(onTag);
      } catch {
        /* ignore */
      }
      void close();
      fn();
    };

    const onTag = async () => {
      try {
        await connect('android.nfc.tech.IsoDep');
        await transceive(APDU_SELECT_AID);
        const bal = await transceive(APDU_BALANCE);
        const bin = await transceive(APDU_READ_BINARY);
        const efc = await transceive(APDU_SELECT_EF);

        // Balance = BE(bal[0:4]) + BE(bal[5:8]); a "01"-prefixed binary read
        // means the counter is offset — subtract (signed) per the official app.
        let balanceCOP = beSlice(bal, 0, 4) + beSlice(bal, 5, 8);
        const binPrefix = hexByte(bin[0]) + hexByte(bin[1]) + hexByte(bin[2]) + hexByte(bin[3]);
        if (binPrefix.startsWith('01')) {
          const b2 = beSlice(bin, 4, 8);
          balanceCOP = balanceCOP > b2 ? balanceCOP - b2 : -(b2 - balanceCOP);
        }

        // Card number = BCD hex of efc[8:16].
        let numeroTarjeta = '';
        for (let i = 8; i < 16 && i < efc.length; i++) numeroTarjeta += hexByte(efc[i]);

        const movements: NfcMovement[] = [];
        for (let i = 1; i <= 10; i++) {
          try {
            const rec = await transceive(apduRecord(i));
            const m = parseMovement(rec);
            if (!m) break;
            movements.push(m);
          } catch {
            break;
          }
        }

        finish(() => resolve({ numeroTarjeta, balanceCOP, movements }));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error('No se pudo leer la tarjeta')));
      }
    };

    nfc.addTagDiscoveredListener(
      onTag,
      undefined,
      (err: any) => finish(() => reject(new Error(`NFC no disponible: ${err ?? ''}`.trim())))
    );
    signal?.addEventListener('abort', () => finish(() => reject(new DOMException('Lectura cancelada', 'AbortError'))));
  });
}

/** Scan one NFC tag. Prefers a native plugin; Web NFC last (blocked in the APK's WebView). */
export function scanCard(signal?: AbortSignal): Promise<NfcCardRead> {
  const capawesome = getNativeNfc();
  if (capawesome) return scanNative(capawesome, signal);
  const phonegap = getPhonegapNfc();
  if (phonegap) return scanPhonegap(phonegap, signal);
  const isNative = Boolean((window as any).Capacitor?.isNativePlatform?.());
  if (isNative) {
    // In the APK with no NFC plugin, Web NFC is disabled by the WebView.
    return Promise.reject(
      new Error('Falta el plugin NFC nativo. Instálalo y reconstruye el APK (ver Ajustes/README).')
    );
  }
  if ('NDEFReader' in window) return scanWeb(signal);
  return Promise.reject(new Error('NFC no está disponible en este dispositivo'));
}
