#!/usr/bin/env python3
"""Scan all distribution helpers for personal path/name strings; record counts only."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'build' / 'verification'
OUT.mkdir(parents=True, exist_ok=True)
needles = {'user_path_count': '/' + 'Users' + '/', 'home_name_count': Path.home().name}
results = []
for mode in ['full', 'trimmed']:
    for arch in ['arm64', 'x86_64', 'universal']:
        for tool in ['ffmpeg', 'ffprobe']:
            binary = ROOT / 'dist' / mode / arch / tool
            if not binary.exists():
                if arch == 'universal':
                    continue
                raise SystemExit(f'Missing required binary: {mode}/{arch}/{tool}')
            p = subprocess.run(['strings', '-a', str(binary)], capture_output=True, check=True)
            strings = p.stdout.decode(errors='replace').splitlines()
            row = {'binary': f'{mode}/{arch}/{tool}'}
            row.update({name: sum(needle in line for line in strings) for name, needle in needles.items()})
            results.append(row)
(OUT / 'privacy.json').write_text(json.dumps(results, indent=2) + '\n')
print('binary user_path_count home_name_count')
for row in results:
    print(row['binary'], row['user_path_count'], row['home_name_count'])
if any(row[name] for row in results for name in needles):
    raise SystemExit('Personal path/name string scan failed')
print(f'{len(results)} binaries scanned; total matches=0')
