// Dependency audit gate: fails on any high or critical npm advisory except the reviewed exceptions below.
// Each exception names why it cannot reach the shipped application and when to remove it. An exception
// that npm no longer reports fails the gate too, so it is removed in the same change as the fix.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const studio = join(dirname(fileURLToPath(import.meta.url)), '..');
const exceptions = new Map([
  // picomatch <= 4.0.7 ReDoS (published 19 Oct 2026, no patched release yet). Reached only through
  // Vite, a build-time devDependency matching globs from our own configuration; nothing from picomatch,
  // fdir, tinyglobby or Vite is bundled into desktop-dist. Remove when a patched picomatch is locked.
  ['GHSA-fc5q-39xc-vjpf', 'picomatch'],
]);
// A fixed command string through the shell finds npm.cmd on Windows and npm elsewhere.
const run = spawnSync('npm audit --json', { cwd: studio, encoding: 'utf8', shell: true });
assert.ok(run.stdout, `npm audit produced no output: ${run.error ?? run.stderr}`);
const report = JSON.parse(run.stdout);
assert.ok(!report.error, `npm audit failed: ${JSON.stringify(report.error)}`);
const blocking = [];
const seen = new Set();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
    const id = via.url?.split('/').pop();
    if (exceptions.get(id) === via.name) seen.add(id);
    else blocking.push(`${via.name} ${via.range}: ${via.severity} ${id ?? via.url} ${via.title}`);
  }
}
assert.deepEqual(blocking, [], 'High or critical npm advisory');
const stale = [...exceptions.keys()].filter((id) => !seen.has(id));
assert.deepEqual(stale, [], 'Audit exception no longer reported; remove it from check_audit.mjs');
console.log(`Dependency audit passed: no high or critical advisories beyond ${seen.size} reviewed exception(s): ${[...seen].join(', ')}.`);
