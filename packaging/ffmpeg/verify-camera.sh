#!/bin/bash
# Read-only smoke with caller-selected Garmin sources; no source copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE=${1:-full}
usage() { echo "Usage: $0 full|trimmed FRONT_FILE REAR_FILE [FRONT_SEEK [REAR_SEEK]]" >&2; exit 2; }
case "$MODE" in full|trimmed) ;; *) usage ;; esac
[[ $# -ge 3 && $# -le 5 ]] || usage
front=$2
rear=$3
front_seek=${4:-0}
rear_seek=${5:-0}
for seek in "$front_seek" "$rear_seek"; do
  [[ "$seek" =~ ^[0-9]+([.][0-9]+)?$ ]] || usage
done
FF="$ROOT/dist/$MODE/arm64/ffmpeg"
PROBE="$ROOT/dist/$MODE/arm64/ffprobe"
OUT="$ROOT/build/verification"
mkdir -p "$OUT"
for camera in front rear; do
  if [[ "$camera" == front ]]; then input=$front; seek=$front_seek; else input=$rear; seek=$rear_seek; fi
  [[ -f "$input" && -r "$input" ]] || { echo "Missing selected $camera input" >&2; exit 1; }
  "$PROBE" -v error -show_entries stream=codec_name,codec_type,width,height,sample_rate,channels:format=duration -of json "$input" > "$OUT/$MODE-real-$camera-probe.json"
  # Full decode of the selected one-second excerpt with both video and audio.
  "$FF" -v error -ss "$seek" -i "$input" -t 1 -f null - > "$OUT/$MODE-real-$camera-decode.log" 2>&1
  # Exercise cut/crop/scale/fps/audio/fades/faststart on original pixels/samples.
  # MPEG-4 software output isolates graph support from sandbox media services.
  if [[ "$camera" == front ]]; then strip=90; else strip=54; fi
  "$FF" -v error -y -ss "$seek" -i "$input" -t 1 \
    -vf "crop=iw:ih-$strip:0:0,scale=320:180:flags=lanczos,setsar=1,fps=30" \
    -af 'highpass=f=90,lowpass=f=12000,volume=0.35,afade=t=in:d=0.15,afade=t=out:st=0.85:d=0.15' \
    -c:v mpeg4 -q:v 3 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -movflags +faststart \
    "$OUT/$MODE-real-$camera.mp4" > "$OUT/$MODE-real-$camera-graph.log" 2>&1
  "$PROBE" -v error -count_frames -show_entries stream=codec_name,codec_type,width,height,nb_read_frames:format=duration -of json \
    "$OUT/$MODE-real-$camera.mp4" > "$OUT/$MODE-real-$camera-output.json"
  "$FF" -v error -i "$OUT/$MODE-real-$camera.mp4" -f null - >> "$OUT/$MODE-real-$camera-graph.log" 2>&1
  echo "$MODE real $camera: source probe, one-second decode, software graph and full output decode passed"
done
