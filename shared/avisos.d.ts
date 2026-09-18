/** One operator notice, as `server/src/data/avisos.json` files it. */
export interface Aviso {
  id: string;
  /** Instant it takes effect, with its offset ("2026-09-18T22:00:00-05:00"). */
  desde: string;
  /** Instant it ends; absent while the notice is open-ended. */
  hasta?: string;
  /** A daily window inside `desde`–`hasta`, in Bogotá time. `dias` are the
   *  days a window STARTS on, 0 = Sunday; a window crossing midnight belongs
   *  to that day. */
  franja?: { dias?: number[]; desde: string; hasta: string };
  /** What it closes: vagón numbers as printed on the signs, and accesses by
   *  the street their Salida sign names. */
  cierra?: { vagones?: string[]; accesos?: string[] };
  /** Service códigos that do not stop while it is in force. */
  omiten?: string[];
  /** Closed vagón → the vagón its services board at instead. */
  trasladan?: Record<string, string>;
  titulo: string;
  detalle?: string;
}

export interface EstadoAvisos {
  vigentes: Aviso[];
  vagones: string[];
  accesos: string[];
  omiten: string[];
  traslados: Record<string, string>;
}

export function avisoVigente(aviso: Aviso | null | undefined, fecha?: Date | number): boolean;
export function estadoAvisos(avisos: Aviso[] | null | undefined, fecha?: Date | number): EstadoAvisos;
