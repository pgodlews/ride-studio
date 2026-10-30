/**
 * Widget framework.
 *
 * A widget is a pure function of (ride, ride time, settings) → SVG. It keeps no internal
 * animation state, timers or CSS transitions, so the same component renders identically
 * in the live preview and frame-by-frame in a video export (output frame / fps → t).
 * Everything a widget animates must come from `t`.
 *
 * Extending:
 *  - new design for an existing metric: `defineWidget({...})` and add it to its family list;
 *  - new metric: add it to METRICS (and any channel it needs to channels.ts);
 *  - new family/style: add a folder under src/widgets with a `family` and a widget list,
 *    then list it in src/widgets/index.ts.
 */
import type { ComponentType } from 'react';
import type { ChannelId } from './channels';
import type { Ride } from './ride';
import type { UnitSystem } from './units';

export type MetricId =
  | 'speed' | 'heartRate' | 'hrZone' | 'cadence' | 'elevation' | 'elevationProfile'
  | 'gradient' | 'temperature' | 'distance' | 'time' | 'respiration' | 'map' | 'streetMap' | 'power'
  | 'pace' | 'stepCadence' | 'steps' | 'splits' | 'climbRate' | 'heading' | 'movingTime' | 'runStrip';

export interface MetricInfo {
  id: MetricId;
  label: string;
  blurb: string;
}

export const METRICS: MetricInfo[] = [
  { id: 'speed', label: 'Speed', blurb: 'Enhanced speed, interpolated between 1 s samples.' },
  { id: 'pace', label: 'Pace', blurb: 'Running/walking pace: the inverse of interpolated speed, min/km or min/mi; stopped shows ––.' },
  { id: 'runStrip', label: 'Run strip', blurb: 'Pace, heart rate with zone, step cadence and distance in one bar.' },
  { id: 'heartRate', label: 'Heart rate', blurb: 'Recorded bpm; animation paced by the real rate.' },
  { id: 'hrZone', label: 'Heart-rate zone', blurb: 'Zones from the Edge’s own boundaries in the FIT file.' },
  { id: 'cadence', label: 'Cadence', blurb: 'Recorded rpm; real zero (coasting) stays zero.' },
  { id: 'stepCadence', label: 'Step cadence', blurb: 'Recorded steps/min; footprints alternate on each step of the integrated cadence.' },
  { id: 'steps', label: 'Steps', blurb: 'Estimated by integrating recorded step cadence; not the watch step counter.' },
  { id: 'elevation', label: 'Elevation', blurb: 'Enhanced altitude, with gain so far.' },
  { id: 'elevationProfile', label: 'Elevation profile', blurb: 'Whole-ride profile by distance with your position.' },
  { id: 'gradient', label: 'Gradient', blurb: 'Derived from altitude over a 60 m window.' },
  { id: 'climbRate', label: 'Climb rate', blurb: 'Vertical speed from altitude over a centred 60 s window, with gain so far.' },
  { id: 'temperature', label: 'Temperature', blurb: 'Device sensor reading.' },
  { id: 'distance', label: 'Distance', blurb: 'Cumulative distance and ride progress.' },
  { id: 'splits', label: 'Splits', blurb: 'Whole-kilometre (or mile) splits from the distance channel: live split and the last three.' },
  { id: 'time', label: 'Time', blurb: 'Local clock (recorded offset) and elapsed time.' },
  { id: 'movingTime', label: 'Moving time', blurb: 'Moving vs elapsed; stopped below a settable speed (default 0.5 m/s).' },
  { id: 'respiration', label: 'Respiration', blurb: 'Garmin respiration-rate estimate.' },
  { id: 'map', label: 'Route map', blurb: 'GPS track; start and finish trimmed for privacy.' },
  { id: 'heading', label: 'Heading', blurb: 'Direction of travel derived from the GPS track.' },
  { id: 'streetMap', label: 'Street map', blurb: 'OpenStreetMap tiles (cached locally) with your track and position; zoom, shape, style and heading-up are settings.' },
  { id: 'power', label: 'Power', blurb: 'Watts from a power meter (not recorded on this ride).' },
];

export interface SettingField {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select' | 'color';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export interface WidgetFrame {
  ride: Ride;
  /** Ride time in seconds since the first record. */
  t: number;
  units: UnitSystem;
  /** Opacity of the widget's backing panel only; text and marks stay opaque. */
  panelOpacity: number;
}

export interface WidgetProps<S = Record<string, unknown>> extends WidgetFrame {
  settings: S;
}

export interface FamilyInfo {
  id: string;
  name: string;
  tagline: string;
}

export interface WidgetDefinition<S = any> {
  /** Stable id used in saved layouts, e.g. "speed.glass". */
  id: string;
  metric: MetricId;
  family: string;
  name: string;
  /** Channels that must have data; otherwise the widget is shown as unavailable. */
  requires: ChannelId[];
  /** Design size in px on a 1080 px-wide frame; the SVG scales with its box. */
  size: { w: number; h: number };
  defaults: S;
  settings?: SettingField[];
  Component: ComponentType<WidgetProps<S>>;
}

export function defineWidget<S extends Record<string, unknown> = Record<string, never>>(
  def: Omit<WidgetDefinition<S>, 'defaults'> & { defaults?: S },
): WidgetDefinition<S> {
  return { ...def, defaults: def.defaults ?? ({} as S) };
}

export class WidgetRegistry {
  private readonly widgets = new Map<string, WidgetDefinition>();
  readonly families: FamilyInfo[] = [];

  addFamily(family: FamilyInfo, widgets: WidgetDefinition[]): this {
    this.families.push(family);
    for (const w of widgets) {
      if (w.family !== family.id) throw new Error(`${w.id}: family ${w.family} ≠ ${family.id}`);
      if (this.widgets.has(w.id)) throw new Error(`Duplicate widget id ${w.id}`);
      this.widgets.set(w.id, w);
    }
    return this;
  }

  get(id: string): WidgetDefinition | undefined {
    return this.widgets.get(id);
  }

  all(): WidgetDefinition[] {
    return [...this.widgets.values()];
  }

  byMetric(metric: MetricId): WidgetDefinition[] {
    const order = this.families.map((f) => f.id);
    return this.all()
      .filter((w) => w.metric === metric)
      .sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
  }

  isAvailable(w: WidgetDefinition, ride: Ride): boolean {
    return w.requires.every((c) => ride.has(c));
  }
}
