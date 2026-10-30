// The only retained exception is the existing Fontsource font assets requested for this alpha.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const studio = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(studio, 'package-lock.json')));
const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);
const bad = [];
for (const [name, p] of Object.entries(lock.packages)) {
  if (!name) continue;
  const font = /^node_modules\/@fontsource(?:-variable)?\//.test(name) && p.license === 'OFL-1.1';
  if (!allowed.has(p.license) && !font) bad.push(`${name}@${p.version}: ${p.license ?? 'missing license'}`);
}
assert.deepEqual(bad, [], 'Dependency license policy violation');
console.log(`Dependency license policy passed: ${Object.keys(lock.packages).length - 1} locked packages; existing OFL fonts retained.`);
