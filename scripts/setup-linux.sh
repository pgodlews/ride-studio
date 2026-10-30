#!/bin/bash
# Developer-alpha setup for Debian/Ubuntu; Node.js 22.12+ (24 recommended) must already be installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${1:-}" == "--help" ]]; then
  echo 'Usage: scripts/setup-linux.sh (installs apt runtime tools, repository Pillow environment, locked npm packages, then builds the desktop alpha)'
  exit 0
fi
command -v apt-get >/dev/null || { echo 'This script supports Debian/Ubuntu (apt). Install FFmpeg, ExifTool and Python 3 venv manually elsewhere.' >&2; exit 1; }
command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || { echo 'Install Node.js 22.12 or later (24 recommended), e.g. from https://nodejs.org or nvm, then rerun this script.' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'Install sudo (or run the apt and chrome-sandbox steps of this script as root), then rerun it as your user.' >&2; exit 1; }
sudo apt-get update
sudo apt-get install -y ffmpeg libimage-exiftool-perl python3-venv
[[ -x "$ROOT/.venv/bin/python" ]] || python3 -m venv "$ROOT/.venv"
"$ROOT/.venv/bin/python" -m pip install -r "$ROOT/requirements-runtime.txt"
npm --prefix "$ROOT/studio" ci
# npm may skip Electron's install script; fetch the pinned runtime explicitly.
ELECTRON="$ROOT/studio/node_modules/electron"
[[ -f "$ELECTRON/path.txt" ]] || node "$ELECTRON/install.js"
# Ubuntu 23.10+ (AppArmor) and hardened Debian (unprivileged_userns_clone=0) restrict unprivileged user
# namespaces, so Chromium needs its setuid sandbox helper.
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 || "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" == 0 ]]; then
  echo 'Configuring the development Electron sandbox helper (root-owned, setuid) for restricted user namespaces.'
  sudo chown root:root "$ELECTRON/dist/chrome-sandbox"
  sudo chmod 4755 "$ELECTRON/dist/chrome-sandbox"
fi
npm --prefix "$ROOT/studio" run desktop:build
printf '%s\n' 'Ready: cd studio && npm run desktop' 'Python helpers use the repository .venv. No Garmin SDK or private activity is needed.'
