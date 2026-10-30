#!/usr/bin/env python3
"""Write measured CLI/dependency/component/media evidence below ignored build/.

Usage: python3 packaging/ffmpeg/verify-macos.py full [trimmed]
Hardware failures are recorded, not suppressed or treated as capability passes.
"""
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import zlib

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
NEEDED = json.loads((ROOT / 'components.json').read_text())
OUT = ROOT / 'build' / 'verification'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'summary.json').unlink(missing_ok=True)


def run(args, log, input=None):
    args = list(map(str, args))
    p = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = p.stdout.decode(errors='replace')
    safe = lambda s: s.replace(str(REPO), '<worktree>')
    with log.open('a') as f:
        f.write('$ ' + safe(' '.join(args)) + '\n' + safe(text) + f'\nexit={p.returncode}\n')
    return p.returncode, text


def png():
    # A transparent 320x180 HUD with a half-alpha dark panel; no external Python deps.
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = []
    for y in range(180):
        rows.append(b'\0' + b''.join(bytes((16, 20, 24, 128)) if x < 100 and y < 60 else b'\0\0\0\0' for x in range(320)))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 320, 180, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')


summary = {}
for mode in sys.argv[1:] or ['full', 'trimmed']:
    if mode not in ['full', 'trimmed']:
        raise SystemExit('Expected full or trimmed')
    log = OUT / f'{mode}.log'
    log.write_text('')
    ff = ROOT / 'dist' / mode / 'arm64' / 'ffmpeg'
    probe = ff.with_name('ffprobe')
    result = {'components': {}, 'sizes': {}, 'checks': {}}
    summary[mode] = result
    for arch in ['arm64', 'x86_64']:
        for tool in ['ffmpeg', 'ffprobe']:
            binary = ROOT / 'dist' / mode / arch / tool
            result['sizes'][f'{arch}/{tool}'] = binary.stat().st_size
            for command in [['lipo', '-archs', binary], ['otool', '-L', binary], ['otool', '-l', binary], ['codesign', '--verify', '--strict', binary], ['codesign', '-dv', '--verbose=2', binary]]:
                code, text = run(command, log)
                if code:
                    raise SystemExit(f'Binary inspection failed: {command[0]}')
            command = [binary, '-version'] if arch == 'arm64' else ['arch', '-x86_64', binary, '-version']
            code, text = run(command, log)
            result['checks'][f'{arch}/{tool}/run'] = {'exit': code, 'last_lines': text.strip().splitlines()[-4:]}
    for option in ['-version', '-buildconf', '-L']:
        code, text = run([ff, option], log)
        if code or (option == '-L' and 'Lesser General Public License' not in text):
            raise SystemExit('License/version check failed')
    for category, names in NEEDED.items():
        if category == 'intentionally_unavailable':
            continue
        code, text = run([ff, '-hide_banner', f'-{category}'], log)
        if code:
            raise SystemExit(f'Listing failed: {category}')
        tokens = set(re.findall(r'[A-Za-z0-9_]+', text))
        missing = [n for n in names if n not in tokens]
        result['components'][category] = {'checked': names, 'missing': missing}
        if missing:
            raise SystemExit(f'Missing {category}: {missing}')
    result['intentional_absences'] = {}
    for category, forbidden in NEEDED['intentionally_unavailable'].items():
        code, text = run([ff, '-hide_banner', f'-{category}'], log)
        # Never treat the description's codec alias as an encoder implementation.
        if code or any(re.search(r'^\s*\S+\s+' + n + r'\s', text, re.M) for n in forbidden):
            raise SystemExit(f'Excluded {category} unexpectedly enabled')
        result['intentional_absences'][category] = forbidden
    for arch in ['arm64', 'x86_64']:
        config = ROOT / 'build' / f'{mode}-{arch}' / 'config.h'
        code, _ = run(['grep', '-E', '^#define CONFIG_(GPL|NONFREE|VERSION3) ', config], log)
        if code or any(f'#define CONFIG_{name} 0' not in config.read_text() for name in ['GPL', 'NONFREE', 'VERSION3']):
            raise SystemExit('License config assertion failed')
    # Actual VideoToolbox H.264 encoding, plus a same-command control on existing FFmpeg.
    vtargs = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p']
    code, text = run([ff, *vtargs, OUT / f'{mode}-vt-h264.mp4'], log)
    result['checks']['vt_h264_encode'] = {'exit': code, 'last_lines': text.strip().splitlines()[-6:]}
    baseline = Path('/opt/homebrew/bin/ffmpeg')
    if code and baseline.exists():
        bcode, btext = run([baseline, *vtargs, OUT / f'{mode}-baseline-vt-h264.mp4'], log)
        result['checks']['baseline_vt_h264_encode'] = {'exit': bcode, 'last_lines': btext.strip().splitlines()[-6:]}
    # HEVC fixture at Garmin's actual stored resolution. Baseline libx265 only creates
    # a local test input and is never linked or included in a distribution.
    hevc = OUT / 'hevc-2688x2160.mp4'
    if not hevc.exists() or not hevc.stat().st_size:
        hcode, htext = run([ff, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=2688x2160:rate=30', '-t', '1', '-c:v', 'hevc_videotoolbox', '-b:v', '4M', hevc], log)
        if hcode and baseline.exists():
            hcode, htext = run([baseline, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=2688x2160:rate=30', '-t', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=2:frame-threads=2:log-level=error', hevc], log)
        if hcode:
            raise SystemExit('Unable to create HEVC test input')
    # Require actual hardware frames: a successful software fallback is not proof
    # of VideoToolbox decoding. hwdownload rejects software-format input frames.
    decode_args = ['-v', 'error', '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-i', hevc, '-vf', 'hwdownload,format=nv12', '-f', 'null', '-']
    code, text = run([ff, *decode_args], log)
    result['checks']['vt_hevc_decode'] = {'exit': code, 'last_lines': text.strip().splitlines()[-6:]}
    if code and baseline.exists():
        bcode, btext = run([baseline, *decode_args], log)
        result['checks']['baseline_vt_hevc_decode'] = {'exit': bcode, 'last_lines': btext.strip().splitlines()[-6:]}
    code, text = run([ff, '-v', 'error', '-i', hevc, '-f', 'null', '-'], log)
    result['checks']['software_hevc_decode'] = {'exit': code, 'last_lines': text.strip().splitlines()[-6:]}
    if code:
        raise SystemExit('Software HEVC decode failed')
    # Mirror studio graph semantics with software MPEG-4 output, so filter checks
    # remain meaningful even when sandbox media services block H.264 encoding.
    fixture = OUT / f'{mode}-fixture.mov'
    code, text = run([ff, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', fixture], log)
    if code:
        raise SystemExit('Software fixture failed')
    output = OUT / f'{mode}-graph.mp4'
    graph = ('[0:v]crop=300:160:10:10,scale=320:180:flags=lanczos,setsar=1,fps=30,trim=end_frame=30,setpts=PTS-STARTPTS,'
             'tpad=start_mode=clone:stop_mode=clone:stop_duration=2,trim=end_frame=30,drawbox=c=white@0.9:t=4[v0];'
             '[0:a]aresample=48000,aformat=channel_layouts=mono,atrim=duration=1,asetpts=PTS-STARTPTS,adelay=0:all=1,'
             'highpass=f=90,lowpass=f=12000,volume=0.35,apad,atrim=duration=1,afade=t=in:d=0.15,afade=t=out:st=0.85:d=0.15,aformat=channel_layouts=stereo[a0];'
             '[v0][a0]concat=n=1:v=1:a=1[vcat][acat];[vcat][1:v]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[vout]')
    code, text = run([ff, '-v', 'error', '-y', '-i', fixture, '-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', 'pipe:0',
                      '-filter_complex', graph, '-map', '[vout]', '-map', '[acat]', '-frames:v', '30', '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-ar', '48000', '-movflags', '+faststart', output], log, input=png() * 30)
    result['checks']['software_hud_graph'] = {'exit': code, 'last_lines': text.strip().splitlines()[-6:]}
    if code:
        raise SystemExit('Software graph failed')
    code, text = run([probe, '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_read_frames:format=duration', '-of', 'json', output], log)
    j = json.loads(text)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    a = next(s for s in j['streams'] if s['codec_type'] == 'audio')
    assert v['width'] == 320 and v['height'] == 180 and int(v['nb_read_frames']) == 30 and a['codec_name'] == 'aac'
    assert abs(float(j['format']['duration']) - 1) < .05
    result['checks']['graph_probe'] = j
    code, text = run([ff, '-v', 'error', '-i', output, '-f', 'null', '-'], log)
    assert code == 0
    # Independent legacy concat demuxer, still, raw RGB and float audio paths.
    listing = OUT / f'{mode}-concat.txt'
    listing.write_text(f"file '{output.name}'\nfile '{output.name}'\n")
    photo = OUT / f'{mode}-photo.png'
    photo.write_bytes(png())
    extra = [
        ['-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', '-movflags', '+faststart', OUT / f'{mode}-concat.mp4'],
        ['-loop', '1', '-framerate', '30', '-t', '1', '-i', photo, '-filter_complex', '[0:v]scale=320:180,fps=30,trim=end_frame=30,setpts=PTS-STARTPTS[v];anullsrc=r=48000:cl=stereo,atrim=duration=1,asetpts=PTS-STARTPTS[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'mpeg4', '-c:a', 'aac', '-frames:v', '30', OUT / f'{mode}-still.mp4'],
        ['-i', output, '-vf', 'scale=18:32', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', OUT / f'{mode}-rgb.raw'],
        ['-i', output, '-vn', '-ac', '1', '-f', 'f32le', OUT / f'{mode}-audio.raw'],
        ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '18x32', '-r', '30', '-i', OUT / f'{mode}-rgb.raw', '-frames:v', '1', '-f', 'null', '-'],
        ['-i', fixture, '-frames:v', '1', '-q:v', '3', OUT / f'{mode}-poster.jpg'],
    ]
    for i, args in enumerate(extra):
        code, text = run([ff, '-v', 'error', '-y', *args], log)
        result['checks'][f'extra_path_{i}'] = {'exit': code, 'last_lines': text.strip().splitlines()[-4:]}
        assert code == 0, args
    print(f'{mode}: component inventory and software HEVC/HUD/still/concat/raw/audio/poster checks passed; hardware exits encode={result["checks"]["vt_h264_encode"]["exit"]} decode={result["checks"]["vt_hevc_decode"]["exit"]}')
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
