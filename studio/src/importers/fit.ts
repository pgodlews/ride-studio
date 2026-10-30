/**
 * Platform-neutral FIT file decoder equivalent to fit_activity.py read_fit().
 *
 * Built on the MIT fit-file-parser package, adapting its native/developer representation:
 * - Rejects header/file CRC mismatches;
 * - Accepts 14-byte headers with zero header CRC when the file CRC is valid;
 * - Maps developer fields to match Garmin SDK developer_fields + field_description key;
 * - Retains unknown and unmapped fields by field definition number (AGENTS.md rule 4);
 * - Platform-neutral: uses globalThis.crypto.subtle, no Node-only or DOM-only APIs.
 */
import FitParser, { FitEncoder, FitBaseType, getFitGarminProductName, type ParsedFit } from 'fit-file-parser';
import { pyRound, sha256Hex } from './util';

export interface FitEvidence {
  source: string;
  sha256: string;
  bytes: number;
  integrity: string;
}

export interface DecodedFitResult {
  messages: Record<string, unknown[]>;
  evidence: FitEvidence;
}

const FIT_EPOCH_UNIX_MS = 631065600000; // 1989-12-31T00:00:00Z in ms
const SEMICIRCLE_INV = 2147483648 / 180; // 2^31 / 180

const RECORD_PROFILE_FIELDS: Record<number, { name: string; scale?: number; offset?: number }> = {
  0: { name: 'position_lat' },
  1: { name: 'position_long' },
  2: { name: 'altitude', scale: 5, offset: -500 },
  3: { name: 'heart_rate' },
  4: { name: 'cadence' },
  5: { name: 'distance', scale: 100 },
  6: { name: 'speed', scale: 1000 },
  7: { name: 'power' },
  8: { name: 'compressed_speed_distance' },
  9: { name: 'grade', scale: 100 },
  10: { name: 'resistance' },
  11: { name: 'time_from_course', scale: 1000 },
  12: { name: 'cycle_length', scale: 100 },
  13: { name: 'temperature' },
  17: { name: 'speed1s', scale: 16 },
  18: { name: 'cycles' },
  19: { name: 'total_cycles' },
  28: { name: 'compressed_accumulated_power' },
  29: { name: 'accumulated_power' },
  30: { name: 'left_right_balance' },
  31: { name: 'gps_accuracy' },
  32: { name: 'vertical_speed', scale: 1000 },
  33: { name: 'calories' },
  39: { name: 'vertical_oscillation', scale: 10 },
  40: { name: 'stance_time_percent', scale: 100 },
  41: { name: 'stance_time', scale: 10 },
  42: { name: 'activity_type' },
  43: { name: 'left_torque_effectiveness', scale: 2 },
  44: { name: 'right_torque_effectiveness', scale: 2 },
  45: { name: 'left_pedal_smoothness', scale: 2 },
  46: { name: 'right_pedal_smoothness', scale: 2 },
  47: { name: 'combined_pedal_smoothness', scale: 2 },
  48: { name: 'time128', scale: 128 },
  49: { name: 'stroke_type' },
  50: { name: 'zone' },
  51: { name: 'ball_speed', scale: 100 },
  52: { name: 'cadence256', scale: 256 },
  53: { name: 'fractional_cadence', scale: 128 },
  54: { name: 'total_hemoglobin_conc', scale: 100 },
  55: { name: 'total_hemoglobin_conc_min', scale: 100 },
  56: { name: 'total_hemoglobin_conc_max', scale: 100 },
  57: { name: 'saturated_hemoglobin_percent', scale: 10 },
  58: { name: 'saturated_hemoglobin_percent_min', scale: 10 },
  59: { name: 'saturated_hemoglobin_percent_max', scale: 10 },
  62: { name: 'device_index' },
  67: { name: 'left_pco' },
  68: { name: 'right_pco' },
  69: { name: 'left_power_phase', scale: 0.7111111 },
  70: { name: 'left_power_phase_peak', scale: 0.7111111 },
  71: { name: 'right_power_phase', scale: 0.7111111 },
  72: { name: 'right_power_phase_peak', scale: 0.7111111 },
  73: { name: 'enhanced_speed', scale: 1000 },
  78: { name: 'enhanced_altitude', scale: 5, offset: -500 },
  81: { name: 'battery_soc', scale: 2 },
  82: { name: 'motor_power' },
  83: { name: 'vertical_ratio', scale: 100 },
  84: { name: 'stance_time_balance', scale: 100 },
  85: { name: 'step_length', scale: 10 },
  87: { name: 'cycle_length16', scale: 100 },
  90: { name: 'garmin_performance_condition' },
  91: { name: 'absolute_pressure' },
  92: { name: 'depth', scale: 1000 },
  93: { name: 'next_stop_depth', scale: 1000 },
  94: { name: 'next_stop_time' },
  95: { name: 'time_to_surface' },
  96: { name: 'ndl_time' },
  97: { name: 'cns_load' },
  98: { name: 'n2_load' },
  99: { name: 'respiration_rate' },
  108: { name: 'enhanced_respiration_rate', scale: 100 },
  114: { name: 'grit' },
  115: { name: 'flow' },
  116: { name: 'current_stress', scale: 100 },
  117: { name: 'ebike_travel_range' },
  118: { name: 'ebike_battery_level' },
  119: { name: 'ebike_assist_mode' },
  120: { name: 'ebike_assist_level_percent' },
  123: { name: 'air_time_remaining' },
  124: { name: 'pressure_sac', scale: 100 },
  125: { name: 'volume_sac', scale: 100 },
  126: { name: 'rmv', scale: 100 },
  127: { name: 'ascent_rate', scale: 1000 },
  129: { name: 'po2', scale: 100 },
  137: { name: 'potential_stamina' },
  138: { name: 'stamina' },
  139: { name: 'core_temperature', scale: 100 },
  253: { name: 'timestamp' },
};

interface RawMessage {
  global_message_number: number;
  message_index: number;
  little_endian: boolean;
  compressed_timestamp?: number;
  fields: { field_definition_number: number; base_type: number; raw_value: number[] }[];
  developer_fields: { developer_data_index: number; field_definition_number: number; raw_value: number[] }[];
}
const BASE_TYPES: Record<string, number> = { enum: 0, sint8: 1, uint8: 2, sint16: 131, uint16: 132, sint32: 133, uint32: 134, string: 7, float32: 136, float64: 137, uint8z: 10, uint16z: 139, uint32z: 140, byte: 13, sint64: 142, uint64: 143, uint64z: 144 };
const BASE_WIDTHS: Record<number, number> = { 3: 2, 4: 2, 5: 4, 6: 4, 8: 4, 9: 8, 11: 2, 12: 4, 14: 8, 15: 8, 16: 8 };
const SESSION_FIELDS: typeof RECORD_PROFILE_FIELDS = {
  9: { name: 'total_distance', scale: 100 },
  14: { name: 'avg_speed', scale: 1000 }, 15: { name: 'max_speed', scale: 1000 },
  22: { name: 'total_ascent' }, 23: { name: 'total_descent' },
  124: { name: 'enhanced_avg_speed', scale: 1000 }, 125: { name: 'enhanced_max_speed', scale: 1000 },
};
const LAP_FIELDS: typeof RECORD_PROFILE_FIELDS = { 9: { name: 'total_distance', scale: 100 } };

/** Repackage retained native bytes using public FIT definition/data framing.
 * Some real files use noncanonical type flags/sizes that the encoder rejects;
 * keep those exact definitions rather than changing the device's wire types.
 */
function nativeOnlyFit(messages: RawMessage[]): Uint8Array {
  const payload: number[] = [];
  for (const m of messages) {
    const fields = [...m.fields];
    if (m.compressed_timestamp !== undefined) {
      const ts = new Uint8Array(4);
      new DataView(ts.buffer).setUint32(0, m.compressed_timestamp, m.little_endian);
      fields.unshift({ field_definition_number: 253, base_type: FitBaseType.Uint32, raw_value: [...ts] });
    }
    const number = m.global_message_number;
    payload.push(64, 0, m.little_endian ? 0 : 1,
      m.little_endian ? number & 255 : number >> 8,
      m.little_endian ? number >> 8 : number & 255, fields.length);
    for (const f of fields) payload.push(f.field_definition_number, f.raw_value.length, f.base_type);
    payload.push(0);
    for (const f of fields) payload.push(...f.raw_value);
  }
  const bytes = new Uint8Array(14 + payload.length + 2);
  bytes.set([14, 32, 0, 0, 0, 0, 0, 0, 46, 70, 73, 84, 0, 0]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, payload.length, true);
  bytes.set(payload, 14);
  view.setUint16(bytes.length - 2, FitEncoder.calculateCRC(bytes.subarray(0, -2)), true);
  return bytes;
}

function toIsoUtc(date: Date): string {
  const iso = date.toISOString();
  return iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
}

function decodeRawBaseType(
  raw: number[],
  baseType: number,
  littleEndian: boolean,
): unknown {
  const u8 = new Uint8Array(raw);
  if ((baseType & 31) === 7) {
    const nul = raw.indexOf(0);
    return new TextDecoder().decode(u8.subarray(0, nul < 0 ? raw.length : nul));
  }
  // Packed byte components are bytes, not individual uint8 sensor readings.
  if ((baseType & 31) === 13) return raw.every(b => b === 255) ? null : [...raw];
  const view = new DataView(u8.buffer);
  const width = BASE_WIDTHS[baseType & 31] ?? 1;
  if (u8.length % width !== 0) return [...raw];
  const values: (number | null)[] = [];
  for (let i = 0; i < u8.length; i += width) {
    let value: number;
    let invalid: number | undefined;
    switch (baseType & 31) {
      case 0: case 2: value = view.getUint8(i); invalid = 255; break;
      case 1: value = view.getInt8(i); invalid = 127; break;
      case 3: value = view.getInt16(i, littleEndian); invalid = 32767; break;
      case 4: value = view.getUint16(i, littleEndian); invalid = 65535; break;
      case 5: value = view.getInt32(i, littleEndian); invalid = 2147483647; break;
      case 6: value = view.getUint32(i, littleEndian); invalid = 4294967295; break;
      case 8: value = view.getFloat32(i, littleEndian); break;
      case 9: value = view.getFloat64(i, littleEndian); break;
      case 10: value = view.getUint8(i); invalid = 0; break;
      case 11: value = view.getUint16(i, littleEndian); invalid = 0; break;
      case 12: value = view.getUint32(i, littleEndian); invalid = 0; break;
      default: return [...raw]; // retain unsupported wide integers without precision loss
    }
    values.push(value === invalid || !Number.isFinite(value) ? null : value);
  }
  return values.length === 1 ? values[0] : values;

}

function cleanRecordValue(val: unknown, key: string, messageName: string): unknown {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) {
    if (messageName === 'activity' && key === 'local_timestamp') {
      return (val.getTime() - FIT_EPOCH_UNIX_MS) / 1000;
    }
    return toIsoUtc(val);
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    if (
      key === 'position_lat' ||
      key === 'position_long' ||
      key === 'start_position_lat' ||
      key === 'start_position_long' ||
      key === 'end_position_lat' ||
      key === 'end_position_long'
    ) {
      return pyRound(val * SEMICIRCLE_INV, 0);
    }
    return val;
  }
  if (typeof val === 'string') {
    return val === '' ? null : val;
  }
  if (Array.isArray(val)) {
    const cleaned = val.map((item) => cleanRecordValue(item, key, messageName));
    if (cleaned.every((item) => item === null || item === undefined)) return null;
    return cleaned;
  }
  if (typeof val === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      const cv = cleanRecordValue(v, k, messageName);
      if (cv !== null && cv !== undefined && cv !== '') {
        obj[k] = cv;
      }
    }
    return obj;
  }
  return val;
}

function cleanMessage(msg: Record<string, unknown>, messageName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg)) {
    const cv = cleanRecordValue(v, k, messageName);
    if (cv !== null && cv !== undefined && cv !== '') {
      out[k] = cv;
    }
  }

  // Handle device_info and file_id mapping
  if (messageName === 'device_info' || messageName === 'file_id') {
    if (out.garmin_product === undefined && msg.product !== undefined) {
      const prodNum = typeof msg.product === 'number' ? msg.product : undefined;
      const isGarmin = msg.manufacturer === 'garmin' || msg.manufacturer === 1;
      const mapped = isGarmin && prodNum !== undefined ? getFitGarminProductName(prodNum) : undefined;
      if (mapped) {
        out.garmin_product = mapped;
      } else if (isGarmin) {
        if (prodNum !== undefined && prodNum > 0) {
          out.garmin_product = String(prodNum);
        }
      }
    }
    if (messageName === 'device_info') {
      if (
        msg.source_type === 'antplus' &&
        msg.device_type !== undefined &&
        out.antplus_device_type === undefined
      ) {
        out.antplus_device_type = msg.device_type;
      }
    }
  }

  return out;
}

export async function decodeFit(
  input: Uint8Array,
  sourceName: string,
): Promise<DecodedFitResult> {
  const digest = await sha256Hex(input);

  let messages: Record<string, unknown[]> = {};
  let integrity = 'passed';

  const isFit = sourceName.toLowerCase().endsWith('.fit');
  if (isFit) {
    const parser = new FitParser({
      force: false,
      mode: 'list',
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      includeUnmappedMessages: true,
      includeRawMessages: true,
    });

    const ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
    let parsed: ParsedFit;
    try {
      parsed = await parser.parseAsync(ab);
    } catch (err: unknown) {
      const errStr = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      if (
        errStr.includes('CRC') ||
        errStr.includes('header') ||
        errStr.includes('Header') ||
        errStr.includes('small') ||
        errStr.includes('exceeds') ||
        errStr.includes('Missing')
      ) {
        throw new Error('FIT integrity check failed');
      }
      throw new Error(`FIT decode errors: ${errStr}`);
    }

    // Convert parsed messages to <name>_mesgs
    const rawMessages = parsed.messages ?? {};
    for (const [name, list] of Object.entries(rawMessages)) {
      if (!Array.isArray(list)) continue;
      const keyName = /^\d+$/.test(name) || name.endsWith('_mesgs') ? name : `${name}_mesgs`;
      messages[keyName] = list.map((item) =>
        cleanMessage(item as Record<string, unknown>, name),
      );
    }

    // Decode a native-only stream when developer fields exist. Preserve on-wire
    // native bytes, types and endian order, so profile names/scales cannot
    // be overwritten by a developer name or native_field_num claim.
    const retained = parsed.raw_messages ?? [];
    if (retained.some((m: RawMessage) => m.developer_fields.length > 0)) {
      const bin = nativeOnlyFit(retained);
      const nativeParsed = await parser.parseAsync(bin.buffer as ArrayBuffer);
      messages = {};
      for (const [name, list] of Object.entries(nativeParsed.messages ?? {})) {
        if (Array.isArray(list)) messages[/^\d+$/.test(name) ? name : `${name}_mesgs`] =
          list.map(item => cleanMessage(item as Record<string, unknown>, name));
      }
    }

    const descriptions = (messages.field_description_mesgs ?? []) as Record<string, unknown>[];
    descriptions.forEach((fd, i) => { fd.key = i; });
    const devById = new Map<string, Record<string, unknown>>();

    // Reconcile raw native fields (including incompatible on-wire base types)
    // and developer fields separately. Unknown native fields retain numbers.
    const messageNames: Record<number, string> = { 18: 'session', 19: 'lap', 20: 'record' };
    for (const m of retained as RawMessage[]) {
      if (m.global_message_number === 206) {
        const fd = descriptions[m.message_index];
        if (fd) devById.set(`${fd.developer_data_index}:${fd.field_definition_number}`, fd);
      }
      let name = messageNames[m.global_message_number];
      if (!name && m.developer_fields.length) {
        // Resolve less common message names through the MIT parser, once per
        // global number, without maintaining a second complete FIT profile.
        const one = nativeOnlyFit([m]);
        const decoded = await parser.parseAsync(one.buffer as ArrayBuffer);
        name = Object.keys(decoded.messages ?? {})[0];
        if (name) messageNames[m.global_message_number] = name;
      }
      const list = messages[name ? `${name}_mesgs` : String(m.global_message_number)];
      if (!list) continue;
      const rec = list[m.message_index] as Record<string, unknown> | undefined;
      if (!rec) continue;
      const profile = m.global_message_number === 20 ? RECORD_PROFILE_FIELDS
        : m.global_message_number === 18 ? SESSION_FIELDS : m.global_message_number === 19 ? LAP_FIELDS : {};
      for (const f of m.fields) {
        const def = profile[f.field_definition_number];
        if (!def) continue;
        // Raw native values win over developer fields, including genuine zeros.
        const decoded = decodeRawBaseType(f.raw_value, f.base_type, m.little_endian);
        const arrayField = m.global_message_number === 20 && [8, 17, 69, 70, 71, 72].includes(f.field_definition_number);
        const raw = Array.isArray(decoded) && !arrayField ? decoded[0] : decoded;
        delete rec[String(f.field_definition_number)];
        if (raw === null) { delete rec[def.name]; continue; }
        if (typeof rec[def.name] === 'string' && def.name !== 'timestamp') continue;
        const scale = (v: unknown) => typeof v === 'number' ? v / (def.scale ?? 1) + (def.offset ?? 0) : v;
        rec[def.name] = Array.isArray(raw) ? raw.map(scale) : scale(raw);
        if (def.name === 'timestamp' && typeof raw === 'number')
          rec.timestamp = toIsoUtc(new Date(FIT_EPOCH_UNIX_MS + raw * 1000));
      }
      const devs: Record<string, unknown> = {};
      for (const f of m.developer_fields) {
        const fd = devById.get(`${f.developer_data_index}:${f.field_definition_number}`);
        if (!fd) { devs[`${f.developer_data_index}:${f.field_definition_number}`] = f.raw_value; continue; }
        let value = decodeRawBaseType(f.raw_value, typeof fd.fit_base_type_id === 'string' ? BASE_TYPES[fd.fit_base_type_id] : Number(fd.fit_base_type_id), m.little_endian);
        if (typeof value === 'number') value = value / (Number(fd.scale) || 1) - (Number(fd.offset) || 0);
        devs[String(fd.key)] = value;
      }
      if (Object.keys(devs).length) rec.developer_fields = devs;
    }

    // Public FIT profile components: low 12 bits = speed / 100 m/s;
    // high 12 bits = accumulated distance / 16 m, modulo 4096.
    // Expand independently, preserving native speed/enhanced_speed/distance.
    let distance = 0;
    for (const rec of (messages.record_mesgs ?? []) as Record<string, unknown>[]) {
      if (rec.enhanced_speed === undefined && typeof rec.speed === 'number') rec.enhanced_speed = rec.speed;
      const packed = rec.compressed_speed_distance;
      if (!Array.isArray(packed) || packed.length !== 3) continue;
      const [a, b, c] = packed.map(v => v === null ? 255 : Number(v));
      const speed = a | ((b & 15) << 8);
      const lowDistance = (b >> 4) | (c << 4);
      distance += (lowDistance - (distance & 4095)) & 4095;
      if (speed !== 4095) {
        if (rec.speed === undefined) rec.speed = speed / 100;
        if (rec.enhanced_speed === undefined) rec.enhanced_speed = Math.trunc((speed / 100) * 1000) / 1000;
      }
      if (rec.distance === undefined) rec.distance = distance / 16;
    }

    // Preserve unmapped native fields for every known message; each unknown
    // message instance is retained (not just its first instance).
    const unmappedCounts = new Map<number, number>();
    for (const u of parsed.unmapped_messages ?? []) {
      const name = messageNames[u.global_message_number];
      let rec = name ? messages[`${name}_mesgs`]?.[u.message_index] as Record<string, unknown> : undefined;
      if (!rec) {
        const key = String(u.global_message_number);
        const idx = unmappedCounts.get(u.global_message_number) ?? 0;
        unmappedCounts.set(u.global_message_number, idx + 1);
        messages[key] ??= [];
        rec = (messages[key][idx] ??= {}) as Record<string, unknown>;
      }
      const profile = u.global_message_number === 20 ? RECORD_PROFILE_FIELDS
        : u.global_message_number === 18 ? SESSION_FIELDS : u.global_message_number === 19 ? LAP_FIELDS : {};
      for (const f of u.fields ?? []) {
        if (profile[f.field_definition_number]) continue;
        const value = decodeRawBaseType(f.raw_value, f.base_type, u.little_endian);
        rec[String(f.field_definition_number)] = value;
      }
      if (u.developer_fields?.length) {
        const devs = (rec.developer_fields ??= {}) as Record<string, unknown>;
        for (const f of u.developer_fields)
          devs[`${f.developer_data_index}:${f.field_definition_number}`] = f.raw_value;
      }
    }
  } else {
    // Decoded JSON input
    const text = new TextDecoder('utf-8').decode(input);
    try {
      messages = JSON.parse(text);
    } catch (e: unknown) {
      throw new Error(`Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`);
    }
    integrity = 'not checked (decoded JSON input)';
  }

  if (!messages || typeof messages !== 'object' || !Array.isArray(messages.record_mesgs) || messages.record_mesgs.length === 0) {
    throw new Error('Input must contain FIT record messages (raw .fit or decoded JSON)');
  }

  return {
    messages,
    evidence: {
      source: sourceName,
      sha256: digest,
      bytes: input.length,
      integrity,
    },
  };
}
