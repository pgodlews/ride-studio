/** Display conversion from SI channel values. Widgets never convert units themselves. */
import type { Quantity } from './channels';

export type UnitSystem = 'metric' | 'imperial';

export interface Display {
  /** Converted numeric value (NaN when missing). */
  value: number;
  /** Formatted text, or the placeholder when missing. */
  text: string;
  unit: string;
  missing: boolean;
}

interface UnitSpec {
  unit: string;
  factor: number;
  offset?: number;
  decimals: number;
}

const SPECS: Record<Quantity, Record<UnitSystem, UnitSpec>> = {
  speed: { metric: { unit: 'km/h', factor: 3.6, decimals: 1 }, imperial: { unit: 'mph', factor: 2.236936, decimals: 1 } },
  distance: { metric: { unit: 'km', factor: 0.001, decimals: 2 }, imperial: { unit: 'mi', factor: 0.000621371, decimals: 2 } },
  altitude: { metric: { unit: 'm', factor: 1, decimals: 0 }, imperial: { unit: 'ft', factor: 3.28084, decimals: 0 } },
  temperature: { metric: { unit: '°C', factor: 1, decimals: 0 }, imperial: { unit: '°F', factor: 1.8, offset: 32, decimals: 0 } },
  heartRate: { metric: { unit: 'bpm', factor: 1, decimals: 0 }, imperial: { unit: 'bpm', factor: 1, decimals: 0 } },
  cadence: { metric: { unit: 'rpm', factor: 1, decimals: 0 }, imperial: { unit: 'rpm', factor: 1, decimals: 0 } },
  pace: { metric: { unit: 'min/km', factor: 1000 / 60, decimals: 2 }, imperial: { unit: 'min/mi', factor: 1609.344 / 60, decimals: 2 } },
  stepCadence: { metric: { unit: 'spm', factor: 1, decimals: 0 }, imperial: { unit: 'spm', factor: 1, decimals: 0 } },
  strideCadence: { metric: { unit: 'strides/min', factor: 1, decimals: 1 }, imperial: { unit: 'strides/min', factor: 1, decimals: 1 } },
  percent: { metric: { unit: '%', factor: 1, decimals: 1 }, imperial: { unit: '%', factor: 1, decimals: 1 } },
  breathRate: { metric: { unit: 'brpm', factor: 1, decimals: 0 }, imperial: { unit: 'brpm', factor: 1, decimals: 0 } },
  power: { metric: { unit: 'W', factor: 1, decimals: 0 }, imperial: { unit: 'W', factor: 1, decimals: 0 } },
  degrees: { metric: { unit: '°', factor: 1, decimals: 0 }, imperial: { unit: '°', factor: 1, decimals: 0 } },
  count: { metric: { unit: '', factor: 1, decimals: 0 }, imperial: { unit: '', factor: 1, decimals: 0 } },
  verticalSpeed: { metric: { unit: 'm/h', factor: 3600, decimals: 0 }, imperial: { unit: 'ft/h', factor: 3600 * 3.28084, decimals: 0 } },
};

export const MISSING = '––';

export function unitFor(q: Quantity, units: UnitSystem): string {
  return SPECS[q][units].unit;
}

export function convert(q: Quantity, si: number, units: UnitSystem): number {
  const s = SPECS[q][units];
  return si * s.factor + (s.offset ?? 0);
}

export function display(q: Quantity, si: number, units: UnitSystem, decimals?: number): Display {
  const s = SPECS[q][units];
  if (!Number.isFinite(si) || (q === 'pace' && si <= 0)) return { value: NaN, text: MISSING, unit: s.unit, missing: true };
  const value = convert(q, si, units);
  if (q === 'pace') {
    const seconds = Math.round(value * 60);
    return { value, text: `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`, unit: s.unit, missing: false };
  }
  const d = decimals ?? s.decimals;
  let text = value.toFixed(d);
  if (text === '-0' || /^-0\.0+$/.test(text)) text = text.slice(1);
  return { value, text, unit: s.unit, missing: false };
}

/** Whole number with thousands separators, independent of the browser locale ("6,842"). */
export function grouped(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** h:mm:ss for elapsed durations. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return MISSING;
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${pad2((s / 60) % 60)}:${pad2(s % 60)}`;
}
