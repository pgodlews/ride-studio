/**
 * Read-only MTP over WebUSB for importing Garmin activities into the studio. Adapted from
 * the Garmin FIT Companion reader, itself adapted from pgodlews/packfade web/index.html;
 * see PACKFADE-LICENSE. Only OpenSession, CloseSession, GetStorageIDs, GetObjectHandles,
 * GetObjectInfo and GetObject are ever sent: no device writes, settings or deletion.
 */
export const MTP = Object.freeze({
  OPEN_SESSION: 0x1002, CLOSE_SESSION: 0x1003, GET_STORAGE_IDS: 0x1004,
  GET_OBJECT_HANDLES: 0x1007, GET_OBJECT_INFO: 0x1008, GET_OBJECT: 0x1009,
  RESPONSE_OK: 0x2001, TYPE_COMMAND: 1, TYPE_DATA: 2, TYPE_RESPONSE: 3,
  FORMAT_FOLDER: 0x3001, ROOT: 0xffffffff,
});
const READ_ONLY = new Set([0x1002, 0x1003, 0x1004, 0x1007, 0x1008, 0x1009]);
export const MTP_LIMIT = 64 * 1024 * 1024;

/** Minimal slice of the WebUSB device the reader needs (lets tests use a fake). */
export interface UsbLike {
  configuration: { interfaces: { interfaceNumber: number; alternate?: UsbAlt; alternates?: UsbAlt[] }[] } | null;
  configurations?: { configurationValue: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  selectAlternateInterface?(n: number, alt: number): Promise<void>;
  transferIn(ep: number, length: number): Promise<{ status: string; data?: DataView }>;
  transferOut(ep: number, data: ArrayBuffer): Promise<{ status: string; bytesWritten: number }>;
}
interface UsbAlt { interfaceClass: number; alternateSetting?: number; endpoints: { endpointNumber: number; direction: string; type: string }[] }

export interface DeviceObject { handle: number; storage: number; format: number; size: number; parent: number; filename: string }

function command(code: number, id: number, params: number[]): ArrayBuffer {
  const bytes = new Uint8Array(12 + 4 * params.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, true);
  view.setUint16(4, MTP.TYPE_COMMAND, true);
  view.setUint16(6, code, true);
  view.setUint32(8, id, true);
  params.forEach((p, i) => view.setUint32(12 + i * 4, p, true));
  return bytes.buffer;
}

function u32Array(bytes: Uint8Array | null): number[] {
  if (!bytes || bytes.length < 4) throw new Error('Malformed MTP array.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > (bytes.length - 4) / 4) throw new Error('Truncated MTP array.');
  return Array.from({ length: count }, (_, i) => view.getUint32(4 + 4 * i, true));
}

export function objectInfo(bytes: Uint8Array | null): Omit<DeviceObject, 'handle'> {
  if (!bytes || bytes.length < 53) throw new Error('Truncated MTP object info.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chars = view.getUint8(52);
  if (53 + chars * 2 > bytes.length) throw new Error('Truncated MTP filename.');
  let filename = '';
  for (let i = 0; i < chars; i++) {
    const code = view.getUint16(53 + 2 * i, true);
    if (!code) break;
    filename += String.fromCharCode(code);
  }
  return { storage: view.getUint32(0, true), format: view.getUint16(4, true), size: view.getUint32(8, true), parent: view.getUint32(38, true), filename };
}

export class MtpReader {
  private transactionId = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private interfaceNumber: number | null = null;
  private sessionOpened = false;
  private inEndpoint = 0;
  private outEndpoint = 0;

  constructor(private readonly device: UsbLike, private readonly timeoutMs = 15000) {}

  private async transfer<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('USB transfer timed out. Reconnect the Garmin and retry.')), this.timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async open(): Promise<void> {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(this.device.configurations?.[0]?.configurationValue || 1);
    for (const iface of this.device.configuration!.interfaces) {
      for (const alt of iface.alternates || [iface.alternate]) {
        if (!alt || ![6, 255].includes(alt.interfaceClass)) continue;
        const input = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
        const output = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
        if (!input || !output) continue;
        await this.device.claimInterface(iface.interfaceNumber);
        this.interfaceNumber = iface.interfaceNumber;
        if (alt.alternateSetting != null && iface.alternate?.alternateSetting !== alt.alternateSetting) {
          await this.device.selectAlternateInterface?.(iface.interfaceNumber, alt.alternateSetting);
        }
        this.inEndpoint = input.endpointNumber;
        this.outEndpoint = output.endpointNumber;
        await this.transaction(MTP.OPEN_SESSION, [1]);
        this.sessionOpened = true;
        return;
      }
    }
    throw new Error('No MTP interface found. A Garmin that mounts as a drive: drop its FIT files instead.');
  }

  async close(): Promise<void> {
    try { if (this.sessionOpened) await this.transaction(MTP.CLOSE_SESSION); } catch { /* unplugged or stalled */ }
    try { if (this.interfaceNumber != null) await this.device.releaseInterface(this.interfaceNumber); } catch { /* unplugged */ }
    try { await this.device.close(); } catch { /* already closed */ }
    this.sessionOpened = false;
    this.interfaceNumber = null;
  }

  private async read(n: number): Promise<Uint8Array> {
    if (!Number.isInteger(n) || n < 0 || n > MTP_LIMIT) throw new Error('Invalid MTP container size.');
    let empty = 0;
    while (this.pendingBytes < n) {
      const result = await this.transfer(this.device.transferIn(this.inEndpoint, 256 * 1024));
      if (result.status !== 'ok' || !result.data) throw new Error(`USB read failed (${result.status}).`);
      const chunk = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (!chunk.length) {
        if (++empty > 100) throw new Error('USB returned no data. Reconnect the Garmin.');
        continue;
      }
      empty = 0;
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
    const output = new Uint8Array(n);
    let position = 0;
    while (position < n) {
      const chunk = this.pending[0];
      const size = Math.min(chunk.length, n - position);
      output.set(chunk.subarray(0, size), position);
      position += size;
      this.pendingBytes -= size;
      if (size === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(size);
    }
    return output;
  }

  private async container() {
    const header = await this.read(12);
    const view = new DataView(header.buffer);
    const length = view.getUint32(0, true);
    if (length < 12 || length > MTP_LIMIT) throw new Error('Malformed MTP container length.');
    return { type: view.getUint16(4, true), code: view.getUint16(6, true), id: view.getUint32(8, true), payload: await this.read(length - 12) };
  }

  async transaction(code: number, params: number[] = []): Promise<Uint8Array | null> {
    if (!READ_ONLY.has(code)) throw new Error('Refusing device operation: this reader is read-only.');
    const id = ++this.transactionId;
    const packet = command(code, id, params);
    const result = await this.transfer(this.device.transferOut(this.outEndpoint, packet));
    if (result.status !== 'ok' || result.bytesWritten !== packet.byteLength) throw new Error('USB command transfer failed.');
    let data: Uint8Array | null = null;
    for (let i = 0; i < 8; i++) {
      const c = await this.container();
      if (c.id !== id) throw new Error('MTP transaction mismatch. Reconnect the Garmin.');
      if (c.type === MTP.TYPE_DATA && c.code === code && data === null) data = c.payload;
      else if (c.type === MTP.TYPE_RESPONSE) {
        if (c.code !== MTP.RESPONSE_OK) throw new Error(`MTP request failed (0x${c.code.toString(16)}). Close other USB apps and reconnect.`);
        return data;
      } else throw new Error('Unexpected MTP container.');
    }
    throw new Error('MTP response was not received.');
  }

  async children(storage: number, parent: number): Promise<DeviceObject[]> {
    const handles = u32Array(await this.transaction(MTP.GET_OBJECT_HANDLES, [storage, 0, parent]));
    const items: DeviceObject[] = [];
    for (const handle of handles) items.push({ handle, ...objectInfo(await this.transaction(MTP.GET_OBJECT_INFO, [handle])) });
    return items;
  }

  /** FIT files in GARMIN/Activity (watches) and GARMIN/Activities (Edge), newest name first. */
  async listActivities(): Promise<DeviceObject[]> {
    const folder = (items: DeviceObject[], name: string) => items.find((o) => o.format === MTP.FORMAT_FOLDER && o.filename.toLowerCase() === name);
    const out: DeviceObject[] = [];
    const seen = new Set<number>();
    for (const storage of u32Array(await this.transaction(MTP.GET_STORAGE_IDS))) {
      const garmin = folder(await this.children(storage, MTP.ROOT), 'garmin');
      if (!garmin) continue;
      const children = await this.children(storage, garmin.handle);
      for (const name of ['activities', 'activity']) {
        const activity = folder(children, name);
        if (!activity) continue;
        for (const file of await this.children(storage, activity.handle)) {
          if (file.format === MTP.FORMAT_FOLDER || !/\.fit$/i.test(file.filename) || seen.has(file.handle)) continue;
          seen.add(file.handle);
          out.push(file);
        }
      }
    }
    return out.sort((a, b) => b.filename.localeCompare(a.filename));
  }

  /** Original bytes of one listed object; the size must match the device's report. */
  async download(file: DeviceObject): Promise<Uint8Array> {
    if (file.size > MTP_LIMIT - 12) throw new Error(`${file.filename} exceeds this browser reader's 64 MiB limit.`);
    const data = await this.transaction(MTP.GET_OBJECT, [file.handle]);
    if (!data || data.length !== file.size) throw new Error(`${file.filename}: USB size does not match the device size.`);
    return data;
  }
}

/** "2026-10-04-10-23-07.fit" → local date-time text, when the Garmin naming is used. */
export function activityDate(filename: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(filename);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : null;
}
