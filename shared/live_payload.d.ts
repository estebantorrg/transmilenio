export function toFiniteNumber(value: unknown): number | null;
export function isBusLike(value: unknown): boolean;
/** Locate the bus array inside any known live payload shape, or `null`. */
export function findBusPayloadArray(payload: any): unknown[] | null;

/** One row of the `/paradero/buses` arrivals board. */
export interface ArrivalItem {
  codigo: string;
  idRuta: string;
  destino: string;
  color: string;
  paradero: string;
  tiempo: string;
  distancia: string;
}
/** Normalize the `/paradero/buses` response to a stable arrivals array. */
export function normalizeArrivalsPayload(payload: any): ArrivalItem[];
