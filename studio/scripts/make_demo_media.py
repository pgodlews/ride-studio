"""Cut short 720p proxy clips around each edit-plan segment for the studio preview.

Proxies are preview-only (small, frequent keyframes for scrubbing); exports must
read the original camera files. Writes ``public/data/demo.json`` describing which
ride and clips the gallery should load. All outputs are local and ignored by Git.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

STUDIO = Path(__file__).resolve().parent.parent
WORKSPACE = STUDIO.parent


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--plan', type=Path, default=WORKSPACE / 'video-studio/edit-plan.json')
    p.add_argument('--ride-id', required=True, help='ride id written by prepare_ride.py')
    p.add_argument('--media-root', type=Path, help='replace source dir with <root>/new-<camera>/')
    p.add_argument('--before', type=float, default=15, help='seconds kept before each segment')
    p.add_argument('--after', type=float, default=25, help='seconds kept after segment start')
    args = p.parse_args()

    plan = json.loads(args.plan.read_text())
    media_dir = STUDIO / 'public/data/media'
    media_dir.mkdir(parents=True, exist_ok=True)
    clips = []
    for n, seg in enumerate(plan['segments'], 1):
        src = Path(seg['source'])
        if args.media_root:
            src = args.media_root / f"new-{seg.get('camera', 'front')}" / src.name
        if not src.exists():
            raise SystemExit(f'Missing source clip: {src}')
        # source_offset_s already includes the per-clip visual clock correction.
        seek = max(0.0, seg['source_offset_s'] - args.before)
        lead = seg['source_offset_s'] - seek
        duration = lead + args.after
        start_utc = datetime.fromisoformat(seg['start_utc'].replace('Z', '+00:00')) - timedelta(seconds=lead)
        name = f'{args.ride_id}-seg{n}.mp4'
        out = media_dir / name
        if not out.exists():
            subprocess.run([
                'ffmpeg', '-v', 'error', '-y', '-ss', f'{seek:.3f}', '-i', str(src), '-t', f'{duration:.3f}',
                '-vf', 'scale=1280:720:flags=lanczos,fps=30', '-an', '-c:v', 'libx264', '-preset', 'medium',
                '-crf', '31', '-g', '30', '-tune', 'fastdecode', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(out)], check=True)
        poster = out.with_suffix('.jpg')
        if not poster.exists():
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{lead:.3f}', '-i', str(out),
                            '-frames:v', '1', '-q:v', '3', str(poster)], check=True)
        clips.append({
            'label': seg.get('role', f'segment {n}').replace('-', ' '),
            'src': f'data/media/{name}',
            'poster': f'data/media/{poster.name}',
            'camera': seg.get('camera', 'front'),
            'startUtc': start_utc.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z',
            'duration': round(duration, 3),
            'width': 1280, 'height': 720,
            'note': 'Preview proxy; seek includes the plan visual_clock_correction_s.',
        })
        print(f'{name}: seek {seek}s, {duration}s from {src.name}')

    demo = {'ride': f'data/rides/{args.ride_id}.json', 'clips': clips}
    (STUDIO / 'public/data/demo.json').write_text(json.dumps(demo, indent=2))
    print('Wrote public/data/demo.json')


if __name__ == '__main__':
    main()
