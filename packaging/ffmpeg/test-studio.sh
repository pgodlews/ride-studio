#!/bin/bash
# Run the unmodified integrations; preserve every exit and log, including failures.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
MODE=${1:-full}
case "$MODE" in full|trimmed) ;; *) echo "Usage: $0 [full|trimmed]" >&2; exit 2 ;; esac
export PATH="$ROOT/dist/$MODE/arm64:$PATH"
export STUDIO_PYTHON=${STUDIO_PYTHON:-"$REPO/.venv/bin/python"}
export PYTHON="$STUDIO_PYTHON"
export PYTHONDONTWRITEBYTECODE=1
export TMPDIR="$ROOT/build/studio-tests/tmp"
mkdir -p "$TMPDIR" "$ROOT/build/studio-tests/$MODE"
[[ -x "$STUDIO_PYTHON" ]] || { echo 'Set STUDIO_PYTHON to the existing repository Python environment' >&2; exit 2; }
[[ -x "$ROOT/dist/$MODE/arm64/ffmpeg" ]] || { echo 'Build this mode first' >&2; exit 2; }
cd "$REPO/studio"
echo "ffmpeg selected: dist/$MODE/arm64/ffmpeg"
failed=0
for name in media camera dji phone photo; do
  log="$ROOT/build/studio-tests/$MODE/$name.log"
  if node "scripts/test_${name}_studio.mjs" > "$log" 2>&1; then code=0; else code=$?; failed=1; fi
  printf '%s exit=%s\n' "test_${name}_studio.mjs" "$code" | tee "$ROOT/build/studio-tests/$MODE/$name.status"
  tail -5 "$log"
done
exit "$failed"
