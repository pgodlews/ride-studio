"""Shared read-only video probing and local footage registration."""
import hashlib
import json
import math
import subprocess

from datetime import datetime

def iso(dt: datetime):
    return dt.isoformat(timespec="microseconds").replace("+00:00", "Z")


def probe_video(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
                             '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    video = [s for s in data['streams'] if s['codec_type'] == 'video']
    if len(video) != 1:
        raise ValueError('Editor needs one reframed video stream; export raw dual-fisheye clips to MP4 first')
    v = video[0]
    a = next((s for s in data['streams'] if s['codec_type'] == 'audio'), None)
    sn, sd = map(int, v.get('sample_aspect_ratio', '1:1').replace('N/A', '1:1').split(':'))
    sar = sn / sd if sn > 0 and sd > 0 else 1
    duration = float(data['format']['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid video duration')
    rotation = float(next((d['rotation'] for d in v.get('side_data_list', []) if 'rotation' in d), v.get('tags', {}).get('rotate', 0)))
    if not math.isfinite(rotation) or abs(rotation / 90 - round(rotation / 90)) > 0.001:
        raise ValueError('Only quarter-turn video orientation is supported')
    # Browser playback and FFmpeg autorotation both apply the display matrix.
    # Crop geometry must describe those oriented pixels, not the stored raster.
    width, height = v['width'], v['height']
    if round(rotation / 90) % 2:
        width, height, sar = height, width, 1 / sar
    return {'duration': duration, 'width': width, 'height': height,
            'displayWidth': round(width * sar), 'codec': v['codec_name'],
            'audio': a['codec_name'] if a else None,
            'containerCreatedUtc': data['format'].get('tags', {}).get('creation_time')}


def registration(video, preview, start, camera, bottom_strip, brand="dji", registration_id=None):
    video = video.resolve(strict=True)
    if video.suffix.lower() not in ({'.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.mts', '.m2ts', '.3gp'} if brand in {'phone', 'gopro', 'exif'} else {'.mp4'}):
        raise ValueError('Editor video must be a supported MOV/MP4/M4V container')
    geometry = probe_video(video)
    alias = brand.upper() + '-' + hashlib.sha256((str(video) + ('|' + registration_id if registration_id else '')).encode()).hexdigest()[:16] + '.MP4'
    entry = dict(geometry, camera=camera, name=alias, sourcePath=str(video),
                 createdUtc=iso(start), clockOffsetSec=0, brand=brand, bottomStrip=bottom_strip, preview=None)
    if preview:
        preview = preview.resolve(strict=True)
        p = probe_video(preview)
        if abs(p['duration'] - geometry['duration']) > 0.1:
            raise ValueError('Preview must preserve the full video duration and playback-zero alignment')
        if abs(p['displayWidth'] / p['height'] - geometry['displayWidth'] / geometry['height']) > 0.01:
            raise ValueError('Preview must preserve the original video aspect ratio')
        entry['preview'] = {'name': alias.replace('.MP4', '-preview.MP4'), 'width': p['width'],
                            'height': p['height'], 'codec': p['codec'], 'sourcePath': str(preview)}
    return entry


def browser_preview(video, output):
    """Write a full-timeline H.264/AAC proxy; the original remains the export input."""
    output.parent.mkdir(parents=True, exist_ok=True)
    video = video.resolve(strict=True)
    stat = video.stat()
    source = {'path': str(video), 'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns}
    stamp = output.with_suffix('.source.json')
    if output.exists() and stamp.exists():
        try:
            # A cached proxy is reusable only for the exact file it was made from.
            if json.loads(stamp.read_text()) == source:
                return output
        except (OSError, ValueError):
            pass
    pending = output.with_suffix('.pending.mp4')
    try:
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-map', '0:v:0', '-map', '0:a:0?',
                        '-vf', "scale='min(1280,iw)':-2,fps=30", '-c:v', 'libx264', '-preset', 'veryfast',
                        '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                        '-movflags', '+faststart', str(pending)], check=True, capture_output=True)
        pending.rename(output)
        stamp.write_text(json.dumps(source))
    finally:
        pending.unlink(missing_ok=True)
    return output
