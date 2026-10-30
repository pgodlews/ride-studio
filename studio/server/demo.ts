/** Synthetic telemetry and test-pattern footage, never copied from a real activity. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RideJson } from '../src/core/ride';
import { ffmpegPath, h264Args } from './codecs';

export function syntheticRide(): RideJson {
  const t = Array.from({ length: 121 }, (_, i) => i);
  let distance = 0;
  const speed = t.map((s) => 9 + 3 * Math.sin(s / 12));
  const distances = t.map((s, i) => (distance += i ? (speed[i - 1] + speed[i]) / 2 * (s - t[i - 1]) : 0));
  return { schema: 1, id: 'demo-synthetic', startUtc: '2026-01-01T12:00:00Z', tzOffsetSec: 0, t,
    channels: { speed, distance: distances, altitude: t.map((s) => 70 + 20 * Math.sin(s / 20)), heartRate: t.map((s) => Math.round(135 + 15 * Math.sin(s / 18))), cadence: t.map((s) => Math.round(80 + 10 * Math.sin(s / 15))), lat: t.map(() => 0), lon: distances.map((d) => d / 111320) },
    meta: { hrZones: { highBoundaries: [90, 110, 130, 150, 170, 190] }, laps: [], climbs: [], sensors: [],
      warnings: ['Synthetic demonstration: all readings and footage are generated, not recorded telemetry.'],
      source: 'Generated synthetic demo', summary: { name: 'Synthetic cycling demo', sport: 'cycling', total_distance: distance },
      activity: { sport: 'cycling', subSport: null, name: 'Synthetic cycling demo', primaryMetric: 'speed', indoor: false, gpsSamples: t.length, recordSamples: t.length, routeUsable: true, routeImportEligible: true, exclusionReason: null } } };
}
export async function createDemo(dataRoot: string, video = true) {
  const ride = syntheticRide();
  const rides = join(dataRoot, 'public/data/rides');
  const media = join(dataRoot, 'public/data/media');
  const cache = join(dataRoot, '.cache');
  for (const path of [rides, media, cache]) mkdirSync(path, { recursive: true });
  const ridePath = join(rides, `${ride.id}.json`);
  if (!existsSync(ridePath)) writeFileSync(ridePath, JSON.stringify(ride), { flag: 'wx' });
  const source = join(media, 'synthetic-front.mp4');
  if (video && !existsSync(source)) await promisify(execFile)(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '12', ...h264Args(true), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source]);
  if (existsSync(source)) {
    const manifest = join(cache, 'phone-footage.json');
    const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    if (!entries.some((f: { name: string }) => f.name === 'DEMO-front.MP4')) {
      entries.push({ brand: 'phone', rideId: ride.id, camera: 'front', name: 'DEMO-front.MP4', sourcePath: source,
        createdUtc: ride.startUtc, duration: 12, width: 640, height: 360, displayWidth: 640, codec: 'h264', audio: null, preview: null, bottomStrip: 0, clockOffsetSec: 0 });
      writeFileSync(manifest, JSON.stringify(entries));
    }
    const demo = join(dataRoot, 'public/data/demo.json');
    if (!existsSync(demo)) writeFileSync(demo, JSON.stringify({ ride: `data/rides/${ride.id}.json`, clips: [{ label: 'Synthetic test-pattern footage', src: 'data/media/synthetic-front.mp4', startUtc: ride.startUtc, duration: 12, source: { w: 640, h: 360, originalW: 640, bottomStrip: 0 } }] }), { flag: 'wx' });
  }
  return ride.id;
}
