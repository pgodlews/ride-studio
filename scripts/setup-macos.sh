#!/bin/bash
# Developer-alpha setup; Homebrew itself must already be installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == "--help" ]]; then
  echo 'Usage: scripts/setup-macos.sh (installs Homebrew runtime tools, repository Pillow environment, locked npm packages, then builds the desktop alpha)'
  exit 0
fi
command -v brew >/dev/null || { echo 'Install Homebrew from https://brew.sh, then rerun this script.' >&2; exit 1; }
brew install node@24 python@3.13 ffmpeg exiftool
NODE_DIR="$(brew --prefix node@24)/bin"
export PATH="$NODE_DIR:$PATH"
PYTHON="$(brew --prefix python@3.13)/bin/python3.13"
[[ -x "$ROOT/.venv/bin/python" ]] || "$PYTHON" -m venv "$ROOT/.venv"
"$ROOT/.venv/bin/python" -m pip install -r "$ROOT/requirements-runtime.txt"
npm --prefix "$ROOT/studio" ci
npm --prefix "$ROOT/studio" run desktop:build
printf '%s\n' 'Ready: cd studio && npm run desktop' 'Python helpers use the repository .venv. No Garmin SDK or private activity is needed.'
