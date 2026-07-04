/**
 * NFC card reading (Web NFC — `NDEFReader`).
 *
 * Dependency-free: uses the standard Web NFC API available in Android's System
 * WebView / Chromium, so no native Capacitor plugin or `cap sync` is required
 * and the bundle gains nothing on platforms without it.
 *
 * Honesty (spec §5.5.1a): the tullave card is an encrypted MIFARE DESFire; its
 * balance lives in a key-protected value file we CANNOT read without the
 * operator's keys. NFC here yields the tag's serial (UID) and any NDEF records
 * only. We surface that as `source:"card"` provenance and NEVER present it as a
 * verified balance — the balance stays the server ledger's job.
 */

export interface NfcCardRead {
  serialNumber?: string;
  records: { type: string; text: string }[];
  /** A digit run found in NDEF text, if any (some cards expose a printed number). */
  numericId?: string;
}

export function isNfcSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

function decodeRecord(record: any): { type: string; text: string } | null {
  try {
    if (record.recordType === 'text') {
      const dec = new TextDecoder(record.encoding || 'utf-8');
      return { type: 'text', text: dec.decode(record.data) };
    }
    if (record.recordType === 'url' || record.recordType === 'absolute-url') {
      const dec = new TextDecoder();
      return { type: 'url', text: dec.decode(record.data) };
    }
  } catch {
    /* undecodable record — skip it */
  }
  return null;
}

/**
 * Scan one NFC tag. Resolves on the first read, rejects on error/cancel.
 * Pass an AbortSignal to cancel (e.g. a "cancelar" button or timeout).
 */
export function scanCard(signal?: AbortSignal): Promise<NfcCardRead> {
  if (!isNfcSupported()) return Promise.reject(new Error('NFC no está disponible en este dispositivo'));

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
        const decoded = decodeRecord(rec);
        if (decoded) records.push(decoded);
      }
      const joined = records.map((r) => r.text).join(' ');
      const digits = joined.replace(/\D/g, '');
      done(() =>
        resolve({
          serialNumber: event.serialNumber,
          records,
          numericId: digits.length >= 10 ? digits : undefined,
        })
      );
    };
    reader.onreadingerror = () => done(() => reject(new Error('No se pudo leer la tarjeta. Inténtalo de nuevo.')));

    reader
      .scan(signal ? { signal } : undefined)
      .catch((err: unknown) => done(() => reject(err instanceof Error ? err : new Error('NFC no permitido'))));

    signal?.addEventListener('abort', () => done(() => reject(new DOMException('Lectura cancelada', 'AbortError'))));
  });
}
