"""Inspect/import FIT or timestamped GPX telemetry; skip indoor/GPS-free routes."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfoNotFoundError

from fit_activity import read_fit
from gpx_activity import read_gpx
from prepare_ride import STUDIO, build_ride


def inspect_activity(path, activity_id, *, track=None, sport=None, timezone_name=None):
    if path.suffix.lower() == '.gpx':
        ride, evidence = read_gpx(path, activity_id, track=track, sport=sport, timezone_name=timezone_name)
        messages = None
    else:
        if track is not None or sport is not None or timezone_name is not None:
            raise ValueError('--track, --sport and --timezone apply only to GPX inputs')
        messages, evidence = read_fit(path)
        ride = build_ride(messages, activity_id, path.name)
        ride['meta']['telemetry'] = {'kind': 'fit', 'fit': evidence}
    report = {**evidence, **ride['meta']['activity'], 'inputPath': str(path), 'startUtc': ride['startUtc'],
              'kind': ride['meta']['telemetry']['kind'], 'durationSec': ride['t'][-1] if ride['t'] else 0,
              'channels': sorted(ride['channels']),
              'coverage': {c: sum(v is not None for v in values) for c, values in ride['channels'].items()},
              'warnings': ride['meta']['warnings']}
    return messages, ride, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path, help='raw .fit, decoded FIT JSON, .gpx, or directory of FIT/GPX files')
    parser.add_argument('--recursive', action='store_true', help='include nested folders, e.g. GPX/Current')
    parser.add_argument('--track', type=int, help='GPX track number (1-based); required for multiple tracks')
    parser.add_argument('--sport', choices=['cycling', 'running', 'walking', 'hiking'], help='GPX activity sport; not inferred from names/types')
    parser.add_argument('--timezone', help='GPX display timezone, e.g. Europe/London; defaults to UTC')
    parser.add_argument('--inspect', action='store_true', help='report channels and route eligibility without importing')
    parser.add_argument('--id', help='activity id for a single input; default filename stem with spaces/punctuation replaced by hyphens')
    parser.add_argument('--out-dir', type=Path, default=STUDIO / 'public/data/rides')
    parser.add_argument('--report', type=Path, help='save private inventory JSON outside Git')
    args = parser.parse_args()
    try:
        if args.input.is_dir():
            candidates = args.input.rglob('*') if args.recursive else args.input.iterdir()
            paths = sorted(p for p in candidates if p.is_file() and p.suffix.lower() in {'.fit', '.gpx'})
        else:
            paths = [args.input]
        if not paths:
            raise ValueError('No FIT/GPX files found')
        if args.id and len(paths) != 1:
            raise ValueError('--id requires a single activity')
        prepared = []
        for path in paths:
            activity_id = args.id or re.sub(r'[^A-Za-z0-9_-]+', '-', path.stem).strip('-')
            if not re.fullmatch(r'[A-Za-z0-9_-]+', activity_id):
                raise ValueError('Activity id must use letters, numbers, underscores or hyphens')
            try:
                messages, ride, report = inspect_activity(path, activity_id, track=args.track,
                                                        sport=args.sport, timezone_name=args.timezone)
            except ValueError as error:
                if not args.inspect:
                    raise ValueError(f'{path.name}: {error}') from error
                prepared.append((None, None, {'source': path.name, 'error': str(error)}))
                continue
            prepared.append((messages, ride, report))
        # Preflight before writing anything; preserve earlier imports.
        targets = set()
        for _, ride, report in prepared:
            if ride is None:
                continue
            target = args.out_dir / f'{ride["id"]}.json'
            if not args.inspect and report['routeImportEligible'] and target in targets:
                raise ValueError(f'Duplicate output id: {ride["id"]}; import files separately with unique --id values')
            if report['routeImportEligible']:
                targets.add(target)
            if not args.inspect and report['routeImportEligible'] and target.exists():
                raise ValueError(f'Activity already exists: {target}; choose a new --id or output directory')
        if args.report and args.report.exists():
            raise ValueError('Report already exists; choose a new path to retain earlier evidence')
        for messages, ride, report in prepared:
            if ride is None:
                print(f'{report["source"]}: error: {report["error"]}')
                continue
            if not args.inspect and report['routeImportEligible']:
                args.out_dir.mkdir(parents=True, exist_ok=True)
                target = args.out_dir / f'{ride["id"]}.json'
                target.write_text(json.dumps(ride, separators=(',', ':'), allow_nan=False))
                is_gpx = report['kind'] == 'gpx'
                decoded = STUDIO / ('.cache/activity-gpx' if is_gpx else '.cache/activity-fit') / f'{report["sha256"]}{".gpx" if is_gpx else ".json"}'
                decoded.parent.mkdir(parents=True, exist_ok=True)
                if not decoded.exists():
                    if is_gpx:
                        # Keep exact XML, including unmapped extensions, locally.
                        decoded.write_bytes(Path(report['inputPath']).read_bytes())
                    else:
                        decoded.write_text(json.dumps(messages, separators=(',', ':'), allow_nan=False))
                print(f'Wrote {target}')
            print(f'{report["source"]}: {report["sport"]}/{report["subSport"]}, '
                  f'{report["recordSamples"]} records, GPS={report["gpsSamples"]}, '
                  f'channels={report["channels"]}, '
                  f'route={"eligible" if report["routeImportEligible"] else report["exclusionReason"]}')
            for warning in report['warnings']:
                print('warning:', warning)
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps([r for _, _, r in prepared], indent=2, allow_nan=False))
    except (OSError, ValueError, ZoneInfoNotFoundError) as error:
        parser.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
