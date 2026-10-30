// Read-only WebUSB MTP reader for activity import, against a fake Garmin. Fake transport
// adapted from the Garmin FIT Companion / Packfade WebUSB tests (see src/usb/PACKFADE-LICENSE).
// Usage: node scripts/test_usb_mtp.mjs
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { MTP, MtpReader, activityDate } = await server.ssrLoadModule('/src/usb/mtp.ts');
  const container = (type, code, id, payload = new Uint8Array()) => {
    const out = new Uint8Array(12 + payload.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, out.length, true); v.setUint16(4, type, true); v.setUint16(6, code, true); v.setUint32(8, id, true);
    out.set(payload, 12);
    return out;
  };
  const u32s = (values) => {
    const out = new Uint8Array(values.length * 4);
    const v = new DataView(out.buffer);
    values.forEach((n, i) => v.setUint32(i * 4, n, true));
    return out;
  };
  function fake({ folder = 'Activities', both = false, sizeMismatch = false, openFail = false, disconnect = false, wrongId = false } = {}) {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) % 251);
    const storage = 0x10001;
    const objects = {
      1: { parent: MTP.ROOT, format: MTP.FORMAT_FOLDER, name: 'GARMIN' },
      2: { parent: 1, format: MTP.FORMAT_FOLDER, name: folder },
      3: { parent: 2, format: 0x3000, name: '2026-10-03-12-45-56.fit', data: bytes },
      4: { parent: 2, format: 0x3000, name: 'notes.txt', data: new Uint8Array([1]) },
      7: { parent: 2, format: 0x3000, name: '2026-10-04-09-23-07.FIT', data: new Uint8Array([9, 8, 7]) },
    };
    if (both) {
      objects[5] = { parent: 1, format: MTP.FORMAT_FOLDER, name: 'Activity' };
      objects[6] = { parent: 5, format: 0x3000, name: 'watch.fit', data: new Uint8Array([2, 3, 4]) };
    }
    let queue = new Uint8Array();
    let chunkNo = 0;
    const device = {
      configuration: null, ops: [], released: false, closed: false,
      async open() {}, async close() { this.closed = true; },
      async selectConfiguration() {
        this.configuration = { interfaces: [{ interfaceNumber: 1, alternate: { interfaceClass: 6, endpoints: [
          { endpointNumber: 1, direction: 'in', type: 'bulk' }, { endpointNumber: 2, direction: 'out', type: 'bulk' },
        ] } }] };
      },
      async claimInterface() {}, async releaseInterface() { this.released = true; },
      async transferOut(ep, buf) {
        const v = new DataView(buf);
        const code = v.getUint16(6, true);
        const tid = v.getUint32(8, true);
        const params = Array.from({ length: (v.getUint32(0, true) - 12) / 4 }, (_, i) => v.getUint32(12 + 4 * i, true));
        this.ops.push(code);
        const parts = [];
        let payload;
        if (code === MTP.GET_STORAGE_IDS) payload = u32s([1, storage]);
        if (code === MTP.GET_OBJECT_HANDLES) {
          const ids = Object.keys(objects).map(Number).filter((id) => objects[id].parent === params[2]);
          payload = u32s([ids.length, ...ids]);
        }
        if (code === MTP.GET_OBJECT_INFO) {
          const o = objects[params[0]];
          const name = o.name + '\0';
          payload = new Uint8Array(53 + name.length * 2 + 3);
          const info = new DataView(payload.buffer);
          info.setUint32(0, storage, true); info.setUint16(4, o.format, true);
          info.setUint32(8, (o.data?.length || 0) + (sizeMismatch && o.data ? 1 : 0), true);
          info.setUint32(38, o.parent, true); info.setUint8(52, name.length);
          for (let i = 0; i < name.length; i++) info.setUint16(53 + i * 2, name.charCodeAt(i), true);
        }
        if (code === MTP.GET_OBJECT) {
          if (disconnect) throw new Error('Device disconnected');
          payload = objects[params[0]].data;
        }
        if (payload) parts.push(container(2, code, wrongId && code === MTP.GET_OBJECT ? tid + 1 : tid, payload));
        parts.push(container(3, openFail && code === MTP.OPEN_SESSION ? 0x201e : 0x2001, tid));
        const merged = new Uint8Array(queue.length + parts.reduce((n, p) => n + p.length, 0));
        merged.set(queue);
        let offset = queue.length;
        for (const p of parts) { merged.set(p, offset); offset += p.length; }
        queue = merged;
        return { status: 'ok', bytesWritten: buf.byteLength };
      },
      async transferIn(ep, length) {
        chunkNo++;
        if (chunkNo % 7 === 0) return { status: 'ok', data: new DataView(new ArrayBuffer(0)) };
        const n = Math.min(length, queue.length, [5, 512, 3000, 64][chunkNo % 4]);
        const chunk = queue.slice(0, n);
        queue = queue.subarray(n);
        return { status: 'ok', data: new DataView(chunk.buffer) };
      },
    };
    return { device, bytes };
  }

  // Listing reads only object info; only the chosen file is downloaded, byte-for-byte.
  {
    const { device, bytes } = fake();
    const reader = new MtpReader(device);
    await reader.open();
    const files = await reader.listActivities();
    assert.deepEqual(files.map((f) => f.filename), ['2026-10-04-09-23-07.FIT', '2026-10-03-12-45-56.fit'], 'FIT only, newest name first');
    assert.ok(!device.ops.includes(MTP.GET_OBJECT), 'listing does not read file contents');
    assert.deepEqual(await reader.download(files[1]), bytes, 'fragmented transfers and zero packets preserve bytes');
    await reader.close();
    assert.deepEqual([...new Set(device.ops)].sort(), [0x1002, 0x1003, 0x1004, 0x1007, 0x1008, 0x1009]);
    assert.ok(device.released && device.closed);
  }
  // Watch singular folder (any case) and both folders together.
  for (const options of [{ folder: 'aCtIvItY' }, { folder: 'Activities', both: true }]) {
    const { device } = fake(options);
    const reader = new MtpReader(device);
    await reader.open();
    assert.equal((await reader.listActivities()).length, options.both ? 3 : 2);
    await reader.close();
  }
  // Every non-read operation is refused before anything is sent.
  {
    const { device } = fake();
    const reader = new MtpReader(device);
    await reader.open();
    for (const op of [0x100b, 0x100c, 0x100d, 0x100f, 0x1016]) await assert.rejects(() => reader.transaction(op), /read-only/);
    assert.deepEqual(device.ops, [MTP.OPEN_SESSION]);
    await reader.close();
  }
  // Size mismatch, disconnect and transaction mismatch fail the download; the device is released on close.
  for (const options of [{ sizeMismatch: true }, { disconnect: true }, { wrongId: true }]) {
    const { device } = fake(options);
    const reader = new MtpReader(device);
    await reader.open();
    const [file] = await reader.listActivities();
    await assert.rejects(() => reader.download(file));
    await reader.close();
    assert.ok(device.released && device.closed);
  }
  // A failed session open sends nothing else.
  {
    const { device } = fake({ openFail: true });
    const reader = new MtpReader(device);
    await assert.rejects(() => reader.open(), /0x201e/);
    await reader.close();
    assert.deepEqual(device.ops, [MTP.OPEN_SESSION]);
  }
  // A stalled read is bounded.
  {
    const { device } = fake();
    device.transferIn = () => new Promise(() => {});
    const reader = new MtpReader(device, 10);
    await assert.rejects(() => reader.open(), /timed out/);
    await reader.close();
    assert.ok(device.closed);
  }
  assert.equal(activityDate('2026-10-04-09-23-07.FIT'), '2026-10-04 09:23');
  assert.equal(activityDate('A3J41234.FIT'), null);
  console.log('WebUSB MTP reader passed: list without reading, selected download byte-for-byte, read-only allowlist, failures release the device.');
} finally {
  await server.close();
}
