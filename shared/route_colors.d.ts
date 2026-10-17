/** The two networks a service can belong to. */
export type RouteNetwork = 'troncal' | 'zonal';

export const TRONCAL_COLORS: Record<string, string>;
export const ALIMENTADOR_COLOR: string;
export const RUTA_FACIL_COLOR: string;
export const DEFAULT_TRONCAL_COLOR: string;
export const DEFAULT_ZONAL_COLOR: string;

export function validHexColor(value: string | null | undefined): string | null;
export function normalizeRouteCode(value: string | null | undefined): string;
export function normalizeRouteCodeForMatch(value: string | null | undefined): string;
export function isRutaFacilCode(value: string | null | undefined, network?: RouteNetwork): boolean;
export function getRouteZoneLetters(value: string | null | undefined, network?: RouteNetwork): string[];
export function getTroncalLetter(value: string | null | undefined): string | null;
export function getTroncalColor(value: string | null | undefined): string;
export function getStopTagColor(code: string, catalogColor?: string | null, network?: RouteNetwork): string;
