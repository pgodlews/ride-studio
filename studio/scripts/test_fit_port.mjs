// Parity tests: TypeScript FIT activity import vs Python reference.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? 'python3';
const corpusDir = resolve(studio, '.cache/fit-test-files');
mkdirSync(resolve(studio, '.cache'), { recursive: true });
const runCorpus = process.argv.includes('--corpus') || process.env.FIT_CORPUS_PARITY === '1';

const server = await createServer({
  root: studio,
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});

function runPython(code, ...args) {
  return execFileSync(python, ['-c', code, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 100 * 1024 * 1024,
  });
}

function pyBuildRide(msgs, rideId, source) {
  const code = `
import sys, json
sys.path.insert(0, sys.argv[1])
from prepare_ride import build_ride
msgs = json.loads(sys.argv[2])
ride = build_ride(msgs, sys.argv[3], sys.argv[4])
print(json.dumps(ride, allow_nan=False))
`;
  const out = runPython(code, resolve(studio, 'scripts'), JSON.stringify(msgs), rideId, source);
  return JSON.parse(out);
}

function pyReadFit(filePath) {
  const code = `
import sys, json
sys.path.insert(0, sys.argv[1])
from fit_activity import read_fit
from pathlib import Path
msgs, ev = read_fit(Path(sys.argv[2]))
print(json.dumps({"messages": msgs, "evidence": ev}, allow_nan=False))
`;
  const out = runPython(code, resolve(studio, 'scripts'), filePath);
  return JSON.parse(out);
}

function pyInspectActivity(filePath, activityId) {
  const code = `
import sys, json
sys.path.insert(0, sys.argv[1])
from prepare_activity import inspect_activity
from pathlib import Path
msgs, ride, report = inspect_activity(Path(sys.argv[2]), sys.argv[3])
print(json.dumps({"ride": ride, "report": report}, allow_nan=False))
`;
  const out = runPython(code, resolve(studio, 'scripts'), filePath, activityId);
  return JSON.parse(out);
}

function normalizeSensors(sensors) {
  return (sensors || []).map((s) => s.replace(/_/g, '').toLowerCase());
}

function normalizedRide(ride) {
  return { ...ride, meta: { ...ride.meta, sensors: normalizeSensors(ride.meta.sensors) } };
}

function compareRides(tsRide, pyRide, label = '') {
  assert.deepStrictEqual(normalizedRide(tsRide), normalizedRide(pyRide), label);
}

function differences(a, b, path = '') {
  if (Object.is(a, b) || (a === 0 && b === 0)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k =>
      differences(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [{ path, ts: a ?? null, py: b ?? null }];
}

const ALLOWLIST = {
  'SDK merges buffered strap HR': {
    side: 'TS matches recorded record values; SDK combines the buffered HR stream',
    why: 'The full ride equals a fresh SDK read with merge_heart_rates=False (after other explicitly justified classes). HR merging is deferred.',
  },
  'Python leaks invalid developer sentinels': {
    side: 'TS',
    why: 'Typed invalid developer values are missing; the corrected black-box reference preserves a second genuine zero and its provenance.',
  },
  'Python SDK component expansion overwrites native speed': {
    side: 'TS',
    why: 'The virtual Edge830 records native speed/distance next to constant [255,0,0] compressed bytes. Native values take precedence.',
  },
  'Python SDK native speed promotion overwrites enhanced speed': {
    side: 'TS follows enhanced-field preference; physical speed remains ambiguous',
    why: 'FR55 records enhanced speed 0 and nonzero native speed; Swim2 and one FR955 have conflicting session enhanced/native speeds. Exact raw values are checked.',
  },
  'Newer Garmin product enum': {
    side: 'Python names the device; TS retains the numeric product ID',
    why: 'Product 4565 is fr970 in the newer SDK profile and numeric in the pinned MIT parser. Only this established mapping, including sensor sort order, explains the difference.',
  },
};

function justify(tsRide, py, messages, name) {
  const classes = [];
  const expected = structuredClone(py.justificationRide ?? py.ride);
  const actual = structuredClone(tsRide);
  const diffs = differences(normalizedRide(actual), normalizedRide(py.ride));
  const paths = diffs.map(d => d.path);
  if (py.hr.changes && paths.some(p => p.startsWith('channels.heartRate') || p === 'meta.channelSources.heartRate')) {
    assert.ok(py.hr.messages > 0);
    classes.push('SDK merges buffered strap HR');
  }
  if (py.invalidDeveloperValues && paths.some(p => /^(channels\.(power|cadence|strideCadence|stepCadence)|meta\.channelSources\.(power|cadence|strideCadence|stepCadence))/.test(p))) {
    classes.push('Python leaks invalid developer sentinels');
  }
  if (name.endsWith('8107a0fbe3564d2f670b70687f2dd27d.fit')) {
    const records = messages.record_mesgs;
    assert.equal(records.length, actual.t.length);
    for (let i = 0; i < records.length; i++) {
      assert.deepStrictEqual(records[i].compressed_speed_distance, [255, 0, 0]);
      assert.equal(actual.channels.speed[i], records[i].speed);
      // Ride distance rounds to 2 decimal places; this corpus stores hundredths.
      assert.equal(actual.channels.distance[i], records[i].distance);
      assert.equal(expected.channels.speed[i], 2.55);
      // SDK seeds the packed accumulator with unconverted native centimetres:
      // constant packed distance zero advances to the next 4096-count boundary.
      assert.equal(expected.channels.distance[i], Math.ceil(records[i].distance * 100 / 4096) * 256);
    }
    expected.channels.speed = actual.channels.speed;
    expected.channels.distance = actual.channels.distance;
    classes.push('Python SDK component expansion overwrites native speed');
  }
  const enhancedRecordFiles = ['4892e1485eaf2a7492536e75bcfeb2d0', '777228666c5c91164305b31b23cf618c'];
  if (enhancedRecordFiles.some(id => name.endsWith(`${id}.fit`))) {
    for (let i = 0; i < actual.t.length; i++) {
      assert.equal(messages.record_mesgs[i].enhanced_speed, 0);
      assert.equal(actual.channels.speed[i], 0);
      assert.equal(expected.channels.speed[i], messages.record_mesgs[i].speed);
    }
    expected.channels.speed = actual.channels.speed;
    classes.push('Python SDK native speed promotion overwrites enhanced speed');
  }
  if (name.endsWith('0f7bc27ce8225c4c2f7814496b0580e8.fit') || name.endsWith('057ced34a817a17f0fef73c26dbfd092.fit')) {
    const sess = messages.session_mesgs[0];
    for (const [enhanced, native] of [['enhanced_avg_speed', 'avg_speed'], ['enhanced_max_speed', 'max_speed']]) {
      if (actual.meta.summary[enhanced] !== expected.meta.summary[enhanced]) {
        assert.equal(actual.meta.summary[enhanced], sess[enhanced]);
        assert.equal(expected.meta.summary[enhanced], sess[native]);
        expected.meta.summary[enhanced] = actual.meta.summary[enhanced];
      }
    }
    classes.push('Python SDK native speed promotion overwrites enhanced speed');
  }
  if (py.product4565 && actual.meta.sensors.includes('4565')) {
    actual.meta.sensors = actual.meta.sensors.map(s => s === '4565' ? 'fr970' : s).sort();
    classes.push('Newer Garmin product enum');
  }
  // The primary comparison above never changes/skips channels. This second
  // assertion proves the explicit evidence-based explanations cover EVERY diff.
  compareRides(actual, expected, `Unjustified difference: ${name}`);
  assert.ok(classes.length, `No allowlisted class: ${name}`);
  return [...new Set(classes)];
}

try {
  const { decodeFit } = await server.ssrLoadModule('/src/importers/fit.ts');
  const { buildRide, inspectFitActivity } = await server.ssrLoadModule('/src/importers/fitRide.ts');
  const { FitEncoder, FitBaseType } = await server.ssrLoadModule('fit-file-parser');

  console.log('--- 1. Synthetic FIT Parity Tests ---');

  // Test 1: Real zeros, missing HR sentinel, and valid sensors
  {
    const enc = new FitEncoder();
    enc.writeMessage(0, [
      { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 }, // activity
      { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 }, // garmin
      { number: 4, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
    ]);
    enc.writeMessage(18, [
      { number: 5, size: 1, baseType: FitBaseType.Enum, value: 2 }, // cycling
      { number: 6, size: 1, baseType: FitBaseType.Enum, value: 0 }, // generic
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
      { number: 9, size: 4, baseType: FitBaseType.Uint32, value: 100000 }, // distance
      { number: 14, size: 2, baseType: FitBaseType.Uint16, value: 7500 }, // avg_speed
      { number: 15, size: 2, baseType: FitBaseType.Uint16, value: 12000 }, // max_speed
    ]);
    // Record 0: cadence=0 (real zero), heart_rate=0 (sentinel -> null), speed=0 (real zero), power=0, altitude=100
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 473572256 },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: 10000000 },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: 3000 }, // altitude = (3000/5 - 500) = 100m
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 0 }, // heart_rate = 0 (invalid sentinel)
      { number: 4, size: 1, baseType: FitBaseType.Uint8, value: 0 }, // cadence = 0 (real zero)
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 0 }, // speed = 0 (real zero)
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 0 }, // power = 0 (real zero)
    ]);
    // Record 1: cadence=85, heart_rate=142, speed=6000 (6.0 m/s), power=210, altitude=105
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:08Z')) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 473573000 },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: 10001000 },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: 3025 }, // altitude = 105m
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 142 }, // heart_rate = 142
      { number: 4, size: 1, baseType: FitBaseType.Uint8, value: 85 }, // cadence = 85
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 6000 }, // speed = 6.0 m/s
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 210 }, // power = 210
    ]);
    const bin = enc.close();
    const tmp = resolve(studio, '.cache/.tmp_real_zeros.fit');
    writeFileSync(tmp, bin);
    try {
      const tsDec = await decodeFit(bin, 'real_zeros.fit');
      const tsRide = buildRide(tsDec.messages, 'zeros', 'real_zeros.fit');
      const pyRes = pyReadFit(tmp);
      const pyRide = pyBuildRide(pyRes.messages, 'zeros', 'real_zeros.fit');
      compareRides(tsRide, pyRide, 'Test 1: Real zeros & HR sentinel');
      assert.equal(tsRide.channels.cadence[0], 0, 'Real zero cadence must be 0');
      assert.equal(tsRide.channels.speed[0], 0, 'Real zero speed must be 0');
      assert.equal(tsRide.channels.power[0], 0, 'Real zero power must be 0');
      assert.equal(tsRide.channels.heartRate[0], null, 'Heart rate 0 bpm must be null');
      assert.equal(tsRide.channels.heartRate[1], 142, 'Positive heart rate preserved');
      console.log('  ✓ Test 1: Real zero cadence/speed/power and nonpositive HR sentinel');
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }

  // Test 2: Invalid coordinates, negative speed, and NaN filtering
  {
    const msgs = {
      session_mesgs: [{ sport: 'running', sub_sport: 'generic' }],
      record_mesgs: [
        {
          timestamp: '2026-10-04T09:23:07Z',
          position_lat: 473572256,
          position_long: 10000000,
          speed: 3.5,
          cadence: 80,
          fractional_cadence: 0.5,
          heart_rate: 150,
        },
        {
          timestamp: '2026-10-04T09:23:08Z',
          position_lat: 0x7fffffff, // invalid sentinel
          position_long: 10001000,
          speed: -1.0, // invalid negative speed
          cadence: -5, // invalid cadence
          fractional_cadence: 1.5, // invalid fraction >= 1
          heart_rate: -1, // invalid negative HR
        },
        {
          timestamp: '2026-10-04T09:23:09Z',
          position_lat: 473574000,
          position_long: 10002000,
          speed: 4.0,
          cadence: 82,
          fractional_cadence: 0.0,
          heart_rate: 155,
        },
      ],
    };
    const tsRide = buildRide(msgs, 'invalid_test', 'fixture');
    const pyRide = pyBuildRide(msgs, 'invalid_test', 'fixture');
    compareRides(tsRide, pyRide, 'Test 2: Invalid values');
    assert.equal(tsRide.channels.lat[1], null, 'Invalid latitude sentinel must be null');
    assert.equal(tsRide.channels.lon[1], null, 'Longitude paired with invalid lat must be null');
    assert.equal(tsRide.channels.speed[1], null, 'Negative speed must be null');
    assert.equal(tsRide.channels.strideCadence[1], null, 'Invalid cadence must be null');
    assert.equal(tsRide.channels.stepCadence[1], null, 'Invalid step cadence must be null');
    assert.equal(tsRide.channels.heartRate[1], null, 'Negative heart rate must be null');
    console.log('  ✓ Test 2: Invalid coordinates, negative speed, and fraction bounds');
  }

  // Test 3: Duplicate timestamps and interval gaps
  {
    const msgs = {
      session_mesgs: [{ sport: 'cycling', sub_sport: 'generic' }],
      record_mesgs: [
        { timestamp: '2026-10-04T09:23:07Z', position_lat: 473572256, position_long: 10000000, speed: 5.0 },
        { timestamp: '2026-10-04T09:23:07Z', position_lat: 473572300, position_long: 10000100, speed: 5.1 }, // duplicate
        { timestamp: '2026-10-04T09:23:12Z', position_lat: 473574000, position_long: 10002000, speed: 5.5 }, // 5s gap
      ],
    };
    const tsRide = buildRide(msgs, 'gaps_test', 'fixture');
    const pyRide = pyBuildRide(msgs, 'gaps_test', 'fixture');
    compareRides(tsRide, pyRide, 'Test 3: Gaps and duplicates');
    assert.equal(tsRide.t.length, 2, 'Duplicate record dropped');
    assert.ok(tsRide.meta.warnings.some((w) => w.includes('1 duplicate record timestamps dropped')));
    assert.ok(tsRide.meta.warnings.some((w) => w.includes('1 gaps longer than 1.5 s')));
    console.log('  ✓ Test 3: Duplicate timestamps dropped and intervals > 1.5s counted');
  }

  // Test 4: Developer fields for power and cadence
  {
    const msgs = {
      session_mesgs: [{ sport: 'cycling', sub_sport: 'generic' }],
      field_description_mesgs: [
        { field_name: 'Power', native_mesg_num: 20, native_field_num: 7, key: 0 },
        { field_name: 'Cadence', native_mesg_num: 20, native_field_num: 4, key: 1 },
      ],
      record_mesgs: [
        {
          timestamp: '2026-10-04T09:23:07Z',
          position_lat: 473572256,
          position_long: 10000000,
          developer_fields: { 0: 250, 1: 90 },
        },
        {
          timestamp: '2026-10-04T09:23:08Z',
          position_lat: 473573000,
          position_long: 10001000,
          power: 199, // native power overrides developer field
          cadence: 85, // native cadence overrides developer field
          developer_fields: { 0: 300, 1: 95 },
        },
      ],
    };
    const tsRide = buildRide(msgs, 'dev_fields_test', 'fixture');
    const pyRide = pyBuildRide(msgs, 'dev_fields_test', 'fixture');
    compareRides(tsRide, pyRide, 'Test 4: Developer fields');
    assert.equal(tsRide.channels.power[0], 250, 'Developer power used when native absent');
    assert.equal(tsRide.channels.cadence[0], 90, 'Developer cadence used when native absent');
    assert.equal(tsRide.channels.power[1], 199, 'Native power overrides developer power');
    assert.equal(tsRide.channels.cadence[1], 85, 'Native cadence overrides developer cadence');
    assert.ok(tsRide.meta.channelSources.power.includes('developer field Power'));
    assert.ok(tsRide.meta.channelSources.cadence.includes('developer field Cadence'));
    console.log('  ✓ Test 4: Developer-field power/cadence and native field precedence');
  }

  // Test 5: Multi-session activity rejection
  {
    const msgs = {
      session_mesgs: [{ sport: 'running' }, { sport: 'cycling' }],
      record_mesgs: [{ timestamp: '2026-10-04T09:23:07Z', speed: 3 }],
    };
    assert.throws(
      () => buildRide(msgs, 'multi', 'fixture'),
      /Multiple FIT sessions require separate sport\/time projections/,
    );
    assert.throws(
      () => pyBuildRide(msgs, 'multi', 'fixture'),
      /Multiple FIT sessions require separate sport\/time projections/,
    );
    console.log('  ✓ Test 5: Multi-session activities rejected with identical message');
  }

  // Test 6: 14-byte header with zero header CRC
  {
    const defMsg = [0x40, 0x00, 0x00, 20, 0, 1, 253, 4, 0x86];
    const dataMsg = [0x00, 0x00, 0x00, 0x00, 0x3b]; // timestamp
    const payload = [...defMsg, ...dataMsg];
    const dataLen = payload.length;
    const hdr = [
      14, 0x10, 100, 0,
      dataLen & 0xff, (dataLen >> 8) & 0xff, (dataLen >> 16) & 0xff, (dataLen >> 24) & 0xff,
      0x2e, 0x46, 0x49, 0x54, // .FIT
      0, 0, // header CRC == 0x0000
    ];
    const fileBytesNoCrc = [...hdr, ...payload];
    const fileCrc = FitEncoder.calculateCRC(fileBytesNoCrc);
    const fullBytes = new Uint8Array([...fileBytesNoCrc, fileCrc & 0xff, (fileCrc >> 8) & 0xff]);

    const tmp = resolve(studio, '.cache/.tmp_zero_crc.fit');
    writeFileSync(tmp, fullBytes);
    try {
      const tsDec = await decodeFit(fullBytes, 'zero_crc.fit');
      const pyRes = pyReadFit(tmp);
      assert.equal(tsDec.evidence.integrity, 'passed');
      assert.equal(pyRes.evidence.integrity, 'passed');
      assert.equal(tsDec.messages.record_mesgs.length, 1);
      assert.equal(pyRes.messages.record_mesgs.length, 1);
      console.log('  ✓ Test 6: 14-byte header with zero header CRC accepted');
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }

  // Test 7: Corrupted file rejection
  {
    const enc = new FitEncoder();
    enc.writeMessage(0, [
      { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
      { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },
      { number: 4, size: 4, baseType: FitBaseType.Uint32, value: 1000000 },
    ]);
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: 1000000 },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 5000 },
    ]);
    const valid = enc.close();
    const corrupted = new Uint8Array(valid);
    corrupted[16] ^= 0xff; // corrupt a payload byte

    const tmp = resolve(studio, '.cache/.tmp_corrupt.fit');
    writeFileSync(tmp, corrupted);
    try {
      await assert.rejects(() => decodeFit(corrupted, 'corrupt.fit'), /FIT integrity check failed/);
      assert.throws(() => pyReadFit(tmp), /FIT integrity check failed/);
      console.log('  ✓ Test 7: Corrupted file rejected with identical integrity error');
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }

  // Test 8: Decoded JSON input support
  {
    const msgs = {
      record_mesgs: [
        { timestamp: '2026-10-04T09:23:07Z', position_lat: 473572256, position_long: 10000000, speed: 5.0 },
        { timestamp: '2026-10-04T09:23:08Z', position_lat: 473573000, position_long: 10001000, speed: 6.0 },
      ],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(msgs));
    const tsDec = await decodeFit(jsonBytes, 'activity.json');
    assert.equal(tsDec.evidence.integrity, 'not checked (decoded JSON input)');
    assert.equal(tsDec.messages.record_mesgs.length, 2);
    console.log('  ✓ Test 8: Decoded JSON input accepted with matching evidence');
  }

  // Test 9: inspectFitActivity parity
  {
    const enc = new FitEncoder();
    enc.writeMessage(0, [
      { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
      { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },
      { number: 4, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
    ]);
    enc.writeMessage(18, [
      { number: 5, size: 1, baseType: FitBaseType.Enum, value: 2 }, // cycling
      { number: 6, size: 1, baseType: FitBaseType.Enum, value: 0 },
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
    ]);
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:07Z')) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 473572256 },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: 10000000 },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 5000 },
    ]);
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date('2026-10-04T09:23:08Z')) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: 473573000 },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: 10001000 },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 6000 },
    ]);
    const bin = enc.close();
    const tmp = resolve(studio, '.cache/.tmp_inspect.fit');
    writeFileSync(tmp, bin);
    try {
      const { ride: tsRide, report: tsRep } = await inspectFitActivity(bin, 'inspect-test', '.tmp_inspect.fit', tmp);
      const { ride: pyRide, report: pyRep } = pyInspectActivity(tmp, 'inspect-test');
      compareRides(tsRide, pyRide, 'Test 9: inspectFitActivity ride');
      assert.deepStrictEqual(tsRep, pyRep);
      console.log('  ✓ Test 9: inspectFitActivity produces identical ride and report');
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }

  // Test 10: Public profile component bits, distance rollover, native precedence.
  {
    const enc = new FitEncoder();
    const packed = (speed, distance) => new Uint8Array([speed & 255,
      (speed >> 8) | ((distance & 15) << 4), distance >> 4]);
    for (const [i, speed, distance] of [[0, 487, 4090], [1, 402, 10], [2, 0, 20]]) {
      enc.writeMessage(20, [
        { number: 253, size: 4, baseType: FitBaseType.Uint32, value: 1000000 + i },
        { number: 8, size: 3, baseType: FitBaseType.Byte, value: packed(speed, distance) },
      ]);
    }
    const bin = enc.close(), tmp = resolve(studio, '.cache/.tmp_components.fit');
    writeFileSync(tmp, bin);
    try {
      const dec = await decodeFit(bin, 'components.fit');
      const ref = pyReadFit(tmp);
      compareRides(buildRide(dec.messages, 'components', 'components.fit'),
        pyBuildRide(ref.messages, 'components', 'components.fit'));
      assert.equal(dec.messages.record_mesgs[1].distance, 4106 / 16);
      assert.equal(dec.messages.record_mesgs[0].speed, 4.87);
      assert.equal(dec.messages.record_mesgs[1].enhanced_speed, 4.019);
      assert.equal(dec.messages.record_mesgs[2].speed, 0);
    } finally { rmSync(tmp); }
    const native = new FitEncoder();
    native.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: 1000000 },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 906 },
      { number: 73, size: 4, baseType: FitBaseType.Uint32, value: 1000 },
      { number: 5, size: 4, baseType: FitBaseType.Uint32, value: 45 },
      { number: 8, size: 3, baseType: FitBaseType.Byte, value: packed(255, 0) },
    ]);
    const rec = (await decodeFit(native.close(), 'native.fit')).messages.record_mesgs[0];
    assert.equal(rec.speed, 0.906);
    assert.equal(rec.enhanced_speed, 1);
    assert.equal(rec.distance, 0.45);
    console.log('  ✓ Test 10: Compressed components, rollover, quantization, and native precedence');
  }

  // Attach developer definitions/values to payloads made with the MIT encoder.
  // This helper supplies the developer extension that writeMessage does not expose.
  function withDeveloperFields(enc, developerValues) {
    const bin = enc.close(), payload = [...bin.slice(bin[0], -2)];
    const endDef = 6 + payload[5] * 3;
    payload[0] |= 32;
    payload.splice(endDef, 0, developerValues.length,
      ...developerValues.flatMap(v => [v.number, v.bytes.length, v.index]));
    payload.push(...developerValues.flatMap(v => [...v.bytes]));
    return payload;
  }
  function fitPayload(payload) {
    const header = [14, 32, 0, 0, payload.length & 255, (payload.length >> 8) & 255,
      (payload.length >> 16) & 255, (payload.length >> 24) & 255, 46, 70, 73, 84, 0, 0];
    const bytes = [...header, ...payload], crc = FitEncoder.calculateCRC(bytes);
    return new Uint8Array([...bytes, crc & 255, crc >> 8]);
  }
  // Test 11: Actual wire developer fields, native name collision, sentinel and zero.
  {
    const desc = new FitEncoder();
    desc.writeMessage(207, [
      { number: 1, size: 16, baseType: FitBaseType.Byte, value: new Uint8Array(16).fill(1) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 0 },
    ]);
    for (const [num, name, type, native] of [[0, 'power', 132, 7], [1, 'Cadence', 2, 4], [2, 'Temp', 1, 13]]) {
      const text = FitEncoder.string(name);
      desc.writeMessage(206, [
        { number: 0, size: 1, baseType: FitBaseType.Uint8, value: 0 },
        { number: 1, size: 1, baseType: FitBaseType.Uint8, value: num },
        { number: 2, size: 1, baseType: FitBaseType.Uint8, value: type },
        { number: 3, size: text.length, baseType: FitBaseType.String, value: text },
        { number: 14, size: 2, baseType: FitBaseType.Uint16, value: 20 },
        { number: 15, size: 1, baseType: FitBaseType.Uint8, value: native },
      ]);
    }
    const payload = [...desc.close().slice(14, -2)];
    for (let i = 0; i < 2; i++) {
      const enc = new FitEncoder();
      enc.writeMessage(20, [
        { number: 253, size: 4, baseType: FitBaseType.Uint32, value: 1000000 + i },
        { number: 13, size: 1, baseType: FitBaseType.Uint8, value: 29 }, // nonstandard wire type
        { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 200 + i },
        { number: 250, size: 2, baseType: FitBaseType.Uint16, value: 1234 }, // unknown native
      ]);
      payload.push(...withDeveloperFields(enc, [
        { number: 0, index: 0, bytes: new Uint8Array(i ? [0, 0] : [255, 255]) },
        { number: 1, index: 0, bytes: new Uint8Array([i ? 0 : 255]) },
        { number: 2, index: 0, bytes: new Uint8Array([30]) },
      ]));
    }
    const info = new FitEncoder();
    info.writeMessage(23, [
      { number: 4, size: 2, baseType: FitBaseType.Uint16, value: 1 },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 123 },
    ]);
    payload.push(...withDeveloperFields(info, [{ number: 2, index: 0, bytes: new Uint8Array([31]) }]));
    const bin = fitPayload(payload), tmp = resolve(studio, '.cache/.tmp_developer.fit');
    writeFileSync(tmp, bin);
    try {
      const dec = await decodeFit(bin, 'developer.fit');
      const [first, second] = dec.messages.record_mesgs;
      assert.equal(dec.messages.device_info_mesgs[0].developer_fields['2'], 31);
      assert.ok(!('Temp' in dec.messages.device_info_mesgs[0]));
      assert.equal(first.temperature, 29);
      assert.equal(first.power, 200);
      assert.equal(first['250'], 1234);
      assert.ok(!('Temp' in first) && !('Cadence' in first) && !('13' in first));
      assert.equal(first.developer_fields['0'], null);
      assert.equal(first.developer_fields['1'], null);
      assert.equal(second.developer_fields['0'], 0);
      assert.equal(second.developer_fields['1'], 0);
      const ref = pyReadFit(tmp);
      // Reference sentinel leak is intentionally corrected; replace it only in
      // this explicit bug regression fixture before comparing the whole ride.
      if (ref.messages.record_mesgs[0].developer_fields)
        ref.messages.record_mesgs[0].developer_fields['1'] = null;
      compareRides(buildRide(dec.messages, 'developer', 'developer.fit'),
        pyBuildRide(ref.messages, 'developer', 'developer.fit'));
    } finally { rmSync(tmp); }
    console.log('  ✓ Test 11: Wire developer fields, native names/values, unknown fields, invalids, and zeros');
  }

  // Test 12: Exact Python rounding for timezone ties, nonfinite JSON and no records.
  {
    const msgs = { record_mesgs: [{ timestamp: '2026-01-01T00:00:00Z', speed: 1.2345 }],
      activity_mesgs: [{ timestamp: '2026-01-01T00:00:00Z', local_timestamp: 1136160000 + 450 }] };
    compareRides(buildRide(msgs, 'ties', 'fixture'), pyBuildRide(msgs, 'ties', 'fixture'));
    assert.throws(() => buildRide({ record_mesgs: [{ speed: 1 }] }, 'missing', 'fixture'),
      /No timestamped record messages found/);
    for (const bytes of [new Uint8Array(), new Uint8Array([14]), new Uint8Array(16)])
      await assert.rejects(() => decodeFit(bytes, 'bad.fit'));
    await assert.rejects(() => decodeFit(new TextEncoder().encode('{}'), 'bad.json'),
      /Input must contain FIT record messages/);
    console.log('  ✓ Test 12: Timezone half-even tie, missing timestamps, malformed and empty inputs');
  }

  console.log('\nAll 12 synthetic parity tests passed!\n');

  // --- 2. Corpus Parity Mode ---
  if (!runCorpus) {
    console.log('Corpus parity check: pass --corpus or FIT_CORPUS_PARITY=1 to run full corpus comparison.');
  } else if (!existsSync(corpusDir)) {
    console.log('Public corpus absent; skipping corpus parity check.');
  } else {
    console.log('--- 2. Full Corpus Parity Run ---');
    function collectFitFiles(dir) {
      const results = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          results.push(...collectFitFiles(full));
        } else if (ent.name.endsWith('.fit')) {
          results.push(full);
        }
      }
      return results;
    }

    const activityFiles = collectFitFiles(resolve(corpusDir, 'Activity'));
    const allFitMessageTypes = resolve(corpusDir, 'AllFitMessageTypes.fit');
    const corpusFiles = existsSync(allFitMessageTypes)
      ? [...activityFiles, allFitMessageTypes]
      : activityFiles;

    console.log(`Found ${corpusFiles.length} corpus files to evaluate.`);

    const { promisify } = await import('node:util');
    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);
    // Fresh reference output on every run, bounded batches in memory: no stale disk cache.
    const pyScript = `
import sys, json, copy
sys.path.insert(0, sys.argv[1])
from fit_activity import read_fit, clean
from garmin_fit_sdk import Decoder, Stream
from prepare_ride import build_ride
from pathlib import Path
for f in json.loads(sys.argv[2]):
    try:
        msgs, _ = read_fit(Path(f))
        ride = build_ride(msgs, "test", Path(f).name)
        # An independent black-box read disables SDK buffered HR merging. No SDK
        # implementation is inspected or reproduced in the TypeScript importer.
        unmerged = msgs
        hr_changes = []
        if msgs.get('hr_mesgs'):
            raw, errors = Decoder(Stream.from_byte_array(bytearray(Path(f).read_bytes()))).read(merge_heart_rates=False)
            if errors:
                raise ValueError(str(errors))
            unmerged = clean(raw)
            assert len(msgs['record_mesgs']) == len(unmerged['record_mesgs'])
            hr_changes = [(i, a.get('heart_rate'), b.get('heart_rate'))
                for i, (a, b) in enumerate(zip(unmerged['record_mesgs'], msgs['record_mesgs']))
                if a.get('heart_rate') != b.get('heart_rate')]
        corrected = copy.deepcopy(unmerged)
        sentinels = {0:255, 1:127, 2:255, 131:32767, 132:65535, 133:2147483647, 134:4294967295}
        descriptions = {str(d['key']):sentinels.get(d.get('fit_base_type_id'))
            for d in corrected.get('field_description_mesgs', [])}
        invalid = 0
        for r in corrected['record_mesgs']:
            for k, v in list(r.get('developer_fields', {}).items()):
                if descriptions.get(k) is not None and v == descriptions[k]:
                    r['developer_fields'][k] = None
                    invalid += 1
        result = {"ok": True, "ride": ride, "invalidDeveloperValues": invalid,
            "hr": {"messages": len(msgs.get('hr_mesgs', [])), "changes": len(hr_changes),
                "filled": sum(c[1] is None for c in hr_changes),
                "replaced": sum(c[1] is not None for c in hr_changes),
                "examples": hr_changes[:3]},
            "product4565": any(d.get('product') == 4565 and d.get('garmin_product') == 'fr970'
                for d in unmerged.get('device_info_mesgs', []))}
        if hr_changes or invalid:
            result['justificationRide'] = build_ride(corrected, 'test', Path(f).name)
    except Exception as e:
        result = {"ok": False, "error": str(e)}
    print(json.dumps(result, allow_nan=False, separators=(',', ':')))
`;
    const counts = { total: corpusFiles.length, compared: 0, identical: 0, differing: 0,
      tsOnly: 0, pyOnly: 0, bothFail: 0, errorsEqual: 0 };
    const diffFiles = [], tsOnlyFiles = [], pyOnlyFiles = [], errorDifferences = [], unexplained = [];
    const classCounts = new Map(), hrSports = new Map();
    let hrFilled = 0, hrReplaced = 0;
    let tsMs = 0, pyMs = 0;
    for (let start = 0; start < corpusFiles.length; start += 128) {
      const batch = corpusFiles.slice(start, start + 128);
      const chunks = Array.from({ length: 8 }, (_, i) => batch.slice(i * 16, (i + 1) * 16)).filter(c => c.length);
      const pyStart = performance.now();
      const outputs = await Promise.all(chunks.map(c => execFileAsync(python,
        ['-c', pyScript, resolve(studio, 'scripts'), JSON.stringify(c)],
        { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 })));
      pyMs += performance.now() - pyStart;
      const pyResults = outputs.flatMap(o => o.stdout.trim().split('\n').map(line => JSON.parse(line)));
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i], name = file.split('/').pop(), py = pyResults[i];
        const tsStart = performance.now();
        let ts, messages;
        try {
          const dec = await decodeFit(readFileSync(file), name);
          messages = dec.messages;
          ts = { ok: true, ride: buildRide(dec.messages, 'test', name) };
        } catch (e) { ts = { ok: false, error: e.message }; }
        tsMs += performance.now() - tsStart;
        if (!ts.ok && !py.ok) {
          counts.bothFail++;
          if (ts.error === py.error) counts.errorsEqual++;
          else errorDifferences.push({ name, ts: ts.error, py: py.error });
        } else if (ts.ok && !py.ok) {
          counts.tsOnly++;
          assert.ok(ts.ride.t.every((t, j, arr) => j === 0 || t > arr[j - 1]));
          const ranges = Object.fromEntries(Object.entries(ts.ride.channels).map(([k, v]) => {
            const valid = v.filter(x => x !== null);
            return [k, valid.length ? [Math.min(...valid), Math.max(...valid)] : null];
          }));
          tsOnlyFiles.push({ name, error: py.error, startUtc: ts.ride.startUtc, records: ts.ride.t.length, ranges });
        } else if (!ts.ok && py.ok) { counts.pyOnly++; pyOnlyFiles.push({ name, error: ts.error }); }
        else {
          counts.compared++;
          try { compareRides(ts.ride, py.ride, name); counts.identical++; }
          catch {
            counts.differing++;
            const diffs = differences(normalizedRide(ts.ride), normalizedRide(py.ride));
            let classes = [];
            try { classes = justify(ts.ride, py, messages, name); }
            catch (e) { unexplained.push({ name, error: e.message.split('\n')[0] }); }
            for (const cls of classes) classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
            if (classes.includes('SDK merges buffered strap HR')) {
              const sport = py.ride.meta.activity.sport;
              hrSports.set(sport, (hrSports.get(sport) ?? 0) + 1);
              hrFilled += py.hr.filled; hrReplaced += py.hr.replaced;
            }
            diffFiles.push({ name, sport: py.ride.meta.activity.sport, classes, hr: py.hr,
              paths: [...new Set(diffs.map(d => d.path.replace(/\.\d+(?=\.|$)/g, '.*')))],
              examples: diffs.slice(0, 8).map(d => ({ ...d, ts: Array.isArray(d.ts) ? { length: d.ts.length, first: d.ts.slice(0, 5) } : d.ts, py: Array.isArray(d.py) ? { length: d.py.length, first: d.py.slice(0, 5) } : d.py })), count: diffs.length });
          }
        }
      }
      console.log(`  Evaluated ${Math.min(start + 128, corpusFiles.length)}/${corpusFiles.length}`);
    }
    console.log('Corpus whole-JSON results:', JSON.stringify(counts));
    console.log(`TS decode+build (one thread): ${(tsMs / 1000).toFixed(2)} s`);
    console.log(`Python decode+build (8 processes, fresh bounded batches): ${(pyMs / 1000).toFixed(2)} s`);
    console.log('Allowlisted classes (counts overlap where a file has two classes):');
    for (const [cls, count] of classCounts) console.log(`  ${cls} | ${count} | ${ALLOWLIST[cls].side} | ${ALLOWLIST[cls].why}`);
    console.log('Buffered HR sports:', JSON.stringify(Object.fromEntries(hrSports)));
    console.log(`Buffered HR record changes: ${hrFilled} missing values filled, ${hrReplaced} recorded values replaced; record counts unchanged.`);
    for (const d of diffFiles) console.log('DIFF', JSON.stringify(d));
    for (const d of errorDifferences) console.log('ERROR DIFF', JSON.stringify(d));
    for (const d of tsOnlyFiles) console.log('TS ONLY', JSON.stringify(d));
    for (const d of pyOnlyFiles) console.log('PY ONLY', JSON.stringify(d));
    writeFileSync(resolve(studio, '.cache/fit-parity-summary.json'), JSON.stringify({counts, tsMs, pyMs, classCounts: Object.fromEntries(classCounts), hrSports: Object.fromEntries(hrSports), hrFilled, hrReplaced, diffFiles, errorDifferences, tsOnlyFiles, pyOnlyFiles, unexplained}, null, 2));
    assert.equal(counts.pyOnly, 0);
    assert.deepStrictEqual(unexplained, [], 'Unallowlisted whole-JSON differences');
    console.log(`Corpus parity passed: ${counts.identical} identical, ${counts.differing} fully justified differences; ${counts.errorsEqual}/${counts.bothFail} shared errors agree.`);
  }
} finally {
  await server.close();
}
