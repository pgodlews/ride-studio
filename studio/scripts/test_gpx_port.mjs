// Parity test: studio/src/importers/gpx.ts vs studio/scripts/gpx_activity.py read_gpx().
// Both sides consume the exact same GPX bytes; the Python side builds each document from
// the reference fixture builders (test_gpx_activity.point / document) so the inputs are
// shared, then reports its (ride, evidence) tuple as JSON for a deep comparison.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.STUDIO_PYTHON ?? process.env.PYTHON ?? 'python3';
const temp = mkdtempSync(join(tmpdir(), 'gpx-port-'));
const server = await createServer({ root: studio, configFile: false, server: { middlewareMode: true }, appType: 'custom' });

const RUNNER = String.raw`
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from test_gpx_activity import point, document, NS, TPX
import gpx_activity

out = Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)

cases = []
def add(name, text, **kw):
    cases.append((name, text, kw))

ext = '<extensions><tpx:TrackPointExtension><tpx:hr>120</tpx:hr><tpx:cad>0</tpx:cad></tpx:TrackPointExtension></extensions>'
garmin = '<extensions><tpx:TrackPointExtension><tpx:hr>130</tpx:hr><tpx:cad>0</tpx:cad><tpx:atemp>12.5</tpx:atemp><tpx:speed>0</tpx:speed></tpx:TrackPointExtension></extensions>'
garmin2 = garmin.replace('<tpx:speed>0', '<tpx:speed>NaN').replace('<tpx:hr>130', '<tpx:hr>0').replace('<tpx:cad>0', '<tpx:cad>255')
foreign = '<extensions><TrackPointExtension xmlns="urn:unknown"><hr>150</hr><speed>99</speed></TrackPointExtension></extensions>'
two_seg = '<trk><trkseg>' + point(20, extra=ext) + point(21, '0.00001', ext) + '</trkseg><trkseg>' + point(22, '0.01', ext) + point(23, '0.01001', ext) + '</trkseg></trk>'

# success cases
add('basic', document(), sport='hiking', timezone_name='Europe/London')
add('garmin_sensors', document('<trk><trkseg>' + point(20, extra=garmin) + point(21, '.00001', garmin2) + '</trkseg></trk>'))
add('garmin_v1', '<gpx xmlns="{ns}" xmlns:tpx="{tpx1}" version="1.1" creator="fixture"><trk><trkseg>'.format(ns=NS, tpx1='http://www.garmin.com/xmlschemas/TrackPointExtension/v1') + point(20, extra='<extensions><tpx:TrackPointExtension><tpx:cad>0</tpx:cad></tpx:TrackPointExtension></extensions>') + point(21, '.00001', '<extensions><tpx:TrackPointExtension><tpx:hr>90</tpx:hr></tpx:TrackPointExtension></extensions>') + '</trkseg></trk></gpx>')
add('foreign', document('<trk><trkseg>' + point(20, extra=foreign) + point(21, '.00001', foreign) + '</trkseg></trk>'))
add('two_segments', document(two_seg))
add('long_gap', document('<trk><trkseg>' + point(20) + point(30, '.01') + '</trkseg></trk>'))
add('invalid_untimed', document('<trk><trkseg>' + point(20) + point(21, '.00001', lat='NaN') + point(22, '.00002') + point(23, '.00003', time='') + point(24, '.00004') + '</trkseg></trk>'))
add('waypoints_only', document('<wpt lat="0" lon="0"><time>2026-08-22T12:00:00Z</time></wpt>'))
add('routes_only', document('<rte><rtept lat="0" lon="0"/><rtept lat="0" lon="1"/></rte>'))
add('untimed_track', document('<trk><trkseg>' + point(0, time='') + point(0, '1', time='') + '</trkseg></trk>'))
add('duplicates', document('<trk><trkseg>' + point(20) + point(20, '1') + point(21, '.00001') + '</trkseg></trk>'))
_trackbody = '<trk><trkseg>' + point(20) + point(21) + '</trkseg></trk>'
add('multi_track_err', document(_trackbody * 2))
add('track_select', document(_trackbody * 2), track=2)
add('offset_plus02', document('<trk><trkseg>' + point(20, time='<time>2026-08-22T18:31:20+02:00</time>') + point(21) + '</trkseg></trk>'))
add('winter_london', document().replace('2026-08-22', '2026-12-22'), timezone_name='Europe/London')
add('gpx10', document('<trk><trkseg>' + point(20, extra='<speed>3</speed>') + point(21, extra='<speed>-1</speed>') + '</trkseg></trk>', namespace='http://www.topografix.com/GPX/1/0'))
add('no_namespace', document(namespace=''))
add('foot_cadence', document('<trk><trkseg>' + point(20, extra='<extensions><tpx:TrackPointExtension><tpx:cad>80</tpx:cad></tpx:TrackPointExtension></extensions>') + point(21, '.00001', '<extensions><tpx:TrackPointExtension><tpx:cad>80</tpx:cad></tpx:TrackPointExtension></extensions>') + '</trkseg></trk>'), sport='hiking')
# Coordinates with 7-9 decimals exercise pyRound(v, 6) incl. half-even ties near the 6th digit.
add('round_coords', document('<trk><trkseg>'
    + point(20, lon='-1.1234567', lat='53.12345678')
    + point(21, lon='0.000000125', lat='0.0000009999')
    + point(22, lon='180.123456789', lat='-8.765432198')
    + point(23, lon='2.0000005', lat='3.0000015')
    + '</trkseg></trk>'))

# error cases
add('backwards', document('<trk><trkseg>' + point(21) + point(20) + '</trkseg></trk>'))
add('track_zero', document('<trk><trkseg>' + point(20) + point(21) + '</trkseg></trk>'), track=0)
add('no_tz', document('<trk><trkseg>' + point(20, time='<time>2026-08-22T16:31:20</time>') + '</trkseg></trk>'))
add('transition', document('<trk><trkseg>' + point(20, time='<time>2026-10-25T00:59:59Z</time>') + point(21, time='<time>2026-10-25T01:00:00Z</time>') + '</trkseg></trk>'), timezone_name='Europe/London')
add('malformed', '<gpx>')
add('wrong_root', '<other/>')
add('doctype', '<!DOCTYPE gpx [<!ENTITY x "text">]>' + document())

results = []
for name, text, kw in cases:
    path = out / (name + '.gpx')
    path.write_text(text, encoding='utf-8')
    item = {'name': name, 'file': path.name, 'id': name, 'ok': True, 'ride': None, 'evidence': None, 'error': None, 'opts': kw}
    try:
        ride, evidence = gpx_activity.read_gpx(path, name,
                                               track=kw.get('track'), sport=kw.get('sport'), timezone_name=kw.get('timezone_name'))
        item['ride'] = ride
        item['evidence'] = evidence
    except ValueError as e:
        item['ok'] = False
        item['error'] = str(e)
    results.append(item)

print(json.dumps(results, allow_nan=False))
`;

try {
  const { readGpx } = await server.ssrLoadModule('/src/importers/gpx.ts');
  const cases = JSON.parse(execFileSync(python, ['-c', RUNNER, join(studio, 'scripts'), temp], { encoding: 'utf8' }));
  let compared = 0;
  for (const c of cases) {
    const bytes = readFileSync(join(temp, c.file));
    let tsError = null;
    let tsResult = null;
    try {
      tsResult = await readGpx(bytes, c.id, {
        track: c.opts.track,
        sport: c.opts.sport,
        timezone: c.opts.timezone_name,
        sourceName: c.file,
      });
    } catch (e) {
      tsError = e instanceof Error ? e.message : String(e);
    }
    if (c.ok) {
      assert.equal(tsError, null, `${c.name}: unexpected TS error ${tsError}`);
      assert.deepStrictEqual(tsResult.ride, c.ride, `${c.name}: ride mismatch`);
      assert.deepStrictEqual(tsResult.evidence, c.evidence, `${c.name}: evidence mismatch`);
    } else {
      assert.ok(tsError !== null, `${c.name}: expected TS error`);
      if (c.error.startsWith('Invalid GPX XML:')) {
        assert.ok(tsError.startsWith('Invalid GPX XML:'), `${c.name}: expected XML error, got ${tsError}`);
      } else {
        assert.equal(tsError, c.error, `${c.name}: error message mismatch`);
      }
    }
    compared++;
  }
  console.log(`GPX port passed: ${compared} cases (input bytes + output) compared against the Python reference.`);
} finally {
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}