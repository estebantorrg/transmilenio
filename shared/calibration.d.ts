export type CalibrationDayType = 'H' | 'S' | 'F';

export interface PlannerCalibrationData {
  version?: number;
  source?: string;
  speeds?: {
    factor?: Partial<Record<CalibrationDayType, number[]>>;
    pairs?: Record<string, Record<string, number>>;
  };
  headways?: Record<string, Partial<Record<CalibrationDayType, number[]>>>;
}

export interface PreparedCalibration {
  factor: Record<CalibrationDayType, Float64Array>;
  /** `from>to` stop códigos → base commercial speed in m/min. */
  pairSpeed: Map<string, number>;
  headways: Map<string, Record<CalibrationDayType, Float64Array>>;
}

export const SPEED_CAP_M_PER_MIN: number;
export const SPEED_FLOOR_M_PER_MIN: number;
export const DAY_TYPES: CalibrationDayType[];

export function prepareCalibration(data: PlannerCalibrationData | null | undefined): PreparedCalibration | null;
export function dayTypeFor(weekday: number, festivo: boolean): CalibrationDayType;
export function hourFactor(prepared: PreparedCalibration | null, dayType: CalibrationDayType, hour: number): number;
export function clampSpeedMpm(mpm: number): number;
export function pairSpeedMpm(prepared: PreparedCalibration | null, fromCode: string, toCode: string): number | null;
export function medianPairSpeedMpm(prepared: PreparedCalibration | null, stopCodes: string[]): number | null;
export function rideSpeedMpm(
  prepared: PreparedCalibration | null,
  stopCodes: string[],
  dayType: CalibrationDayType,
  hour: number,
  fallbackMpm: number
): number;
