# Ride Studio desktop developer alpha

The Electron application lives in `studio/desktop/`. It runs the production React UI and a loopback Node backend, with no Vite development server. It uses Electron itself to capture the shared SVG HUD: an isolated offscreen window renders each frame at the output resolution and streams PNGs into FFmpeg. The shared-texture benchmark remains a prototype; this first application uses the simpler capture path.

## Supported setup

The tested targets are macOS on Apple silicon and Linux x64 (Ubuntu 24.04 desktop, Debian trixie in CI). Node.js 24 is recommended (minimum 22.12). The macOS alpha has only an ad-hoc local signature; it is not Developer ID signed or notarized. The Linux `.deb` and archive are unsigned. Intel macOS, the oldest supported macOS version, Linux arm64 and other distributions have not been accepted for release. Windows x64 is experimental: GitHub Actions builds it on `windows-latest`, runs the type check, backend and preview-proxy suites and the Electron smoke export, and uploads a portable zip, but it has not been tested on a real PC.

From a clean checkout on macOS with Homebrew already installed:

```sh
scripts/setup-macos.sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
cd studio
npm run desktop
```

On Debian or Ubuntu, with Node.js 22.12+ already installed (for example from nodejs.org or nvm):

```sh
scripts/setup-linux.sh
cd studio
npm run desktop
```

The macOS setup script installs Node 24, Python 3.13, FFmpeg and ExifTool with Homebrew; creates the repository `.venv`; installs exactly pinned Pillow from `requirements-runtime.txt`; installs the npm lockfile and builds the production application. The Linux script installs FFmpeg, ExifTool and `python3-venv` with apt, creates the same `.venv` and pinned Pillow environment, fetches the pinned Electron runtime if npm skipped its install script, and, where AppArmor restricts unprivileged user namespaces (Ubuntu 23.10 and later), makes the development `chrome-sandbox` helper root-owned and setuid so Electron keeps its sandbox. The Garmin FIT SDK is not needed to run the application. `requirements.txt` remains a separate developer/reference-test environment.

For the web development UI, run `npm run demo` then `npm run dev` from `studio/`. The demo's readings, route near the equator and test-pattern video are generated and explicitly labelled synthetic. It never reads a private activity or camera share and does not overwrite an existing default demo.

## Windows (experimental)

`scripts/setup-windows.ps1` installs Node.js LTS, Python 3.13, FFmpeg (Gyan build) and ExifTool with winget, creates `.venv` with the pinned Pillow, installs the npm lockfile and builds the application. Python helpers use `.venv\Scripts\python.exe`, a packaged runtime at `%APPDATA%\Ride Studio\runtime\Scripts\python.exe`, or `python` on PATH. The desktop app probes `h264_nvenc`, `h264_qsv` and `h264_amf` with the real export settings and falls back to libx264; a hardware encoder that fails before the first frame is retried with libx264. `npm run desktop:package` writes `release\ride-studio-<version>-win32-x64\` with `Ride Studio.exe` and a zip of it, using the `tar` built into Windows. The executable keeps Electron's file icon (the window and taskbar use the Ride Studio icon while running), and builds are unsigned. The USB/MTP helper and the Encoder-fallback test (which uses a POSIX shell wrapper) are not available on Windows.

## Using the application

- **Activities** accepts FIT and timestamped GPX files through the TypeScript importers. Camera videos use the existing metadata helpers. Still photos are imported in the editor.
- **File → Load synthetic demo** creates a demonstration in the application's own library and opens it. Arrange widgets, select a video passage in the editor and export an MP4.
- **File → Choose camera folder…** selects the directory containing `new-front` and `new-back`. It remembers the path and reads the camera originals in place; it does not copy the share.
- **File → Choose Python environment…** selects the Python executable from an environment containing Pillow. **Ride Studio → Check setup…** reports FFmpeg, FFprobe, Python/Pillow and ExifTool availability.
- **File → Open library folder / Open exports folder** shows your local data and outputs.

The desktop library is under `~/Library/Application Support/Ride Studio/library` on macOS and `~/.config/Ride Studio/library` on Linux. Application assets stay read-only. The stored loopback port and persistent Electron session keep existing local-storage project layouts/timelines available after restart. Imported originals and finished exports are retained. Stopping the application stops its in-memory export jobs; avoid quitting during an export.

## Runtime dependencies and remaining work

| Workflow | Current runtime |
| --- | --- |
| FIT / GPX activity import | Bundled TypeScript; no Python or proprietary Garmin SDK |
| Gallery, editor, telemetry, HUD capture | Electron and bundled application code; no external Chrome |
| Video encode/decode | Installed FFmpeg/FFprobe and AAC; macOS desktop uses `h264_videotoolbox`; Linux desktop uses `h264_nvenc` when a probe encode succeeds, otherwise `libx264` |
| Camera metadata, photos and Apple Health | Existing Python helpers; camera/photo metadata also uses ExifTool and Pillow |

For a packaged `.app`, install the external tools and choose the repository `.venv/bin/python` with the File menu. Alternatively create a runtime environment at `~/Library/Application Support/Ride Studio/runtime` and install `requirements-runtime.txt` there. `STUDIO_PYTHON`, `STUDIO_FFMPEG` and `STUDIO_FFPROBE` can explicitly select executables. An optional `Resources/tools` directory takes precedence in the application PATH, but the package command does not copy installed system binaries. The Linux `.deb` depends on the distribution `ffmpeg` and recommends `libimage-exiftool-perl` and `python3-pil`, so the packaged application can use the system `python3`; a runtime environment at `~/.config/Ride Studio/runtime` or the File menu selection also work.

The application uses hardware H.264 on macOS. The web developer backend retains `libx264` by default for existing reference comparisons; `STUDIO_VIDEO_ENCODER=h264_videotoolbox` selects the LGPL-compatible hardware path there too. Video preview transcodes use the same encoder selection. On Linux the desktop application probes `h264_nvenc` with a tiny encode at startup, because a distribution FFmpeg lists NVENC whether or not an NVIDIA GPU and driver are present, and falls back to `libx264`. `STUDIO_VIDEO_ENCODER` overrides the choice, and **Check setup…** and the smoke output report it. VAAPI and Quick Sync are not wired in yet: they need hardware-upload filters in each FFmpeg graph. Linux decoding stays in software; the VideoToolbox decoder request is macOS-only.

A fully self-contained installer still needs the remaining metadata helpers migrated or a supported runtime distribution, the reproducible LGPL FFmpeg build integrated with its source/license materials, signing/notarization, platform acceptance and an update strategy. No installed Homebrew binary, Garmin SDK, private activity, test corpus or camera file is bundled. Existing fonts are retained for this alpha.

WebUSB is not enabled in the desktop alpha: renderer permissions are denied by default. Use saved FIT files. The existing Chrome web workflow remains separate and read-only. Sync remains approximate; GPS9, HDR/log, native 360 and long-clip drift limits are unchanged.

## Build, package and test

```sh
cd studio
npm run typecheck
npm run desktop:build
npm run desktop:smoke
npm run desktop:package
```

`desktop:build` creates ignored `desktop-dist/` from code only, explicitly disabling Vite's public-directory copying. It builds the UI and HUD ahead of time and bundles the main process/backend. `desktop:package` copies Electron 44.10.0 with Apple’s native tools for the current macOS architecture under ignored `release/`, includes Electron/Chromium license materials, and applies an ad-hoc signature for local integrity. It does not perform Developer ID signing, notarization or publication. On Linux the same command writes `release/ride-studio-<version>-linux-<arch>/` (runnable `ride-studio`), a `.tar.gz` of it and `ride-studio_<version>_<arch>.deb`, using standard system tools (`tar`, `dpkg-deb`, `chmod`, `du`) and FFmpeg to rasterize the window icon. The `.deb` installs under `/usr/lib/ride-studio` with a `/usr/bin/ride-studio` link, desktop entry, scalable icon and `/usr/share/doc/ride-studio/copyright`. Where the kernel restricts unprivileged user namespaces (Ubuntu 23.10 and later) and the installed AppArmor parser accepts it, `postinst` installs and loads `/etc/apparmor.d/ride-studio`: the same unconfined, `userns`-only profile Ubuntu ships for Chrome, VS Code and Signal, attached to `/usr/lib/ride-studio/ride-studio`. Chromium then uses its preferred namespace sandbox. `prerm` unloads and removes the profile. Older parsers (Ubuntu 22.04, Debian 12) and unrestricted kernels get no profile. `chrome-sandbox` stays root-owned and setuid as the fallback for hosts where user namespaces are unavailable. An ordinary user extracting the archive cannot restore root ownership or the setuid bit, so its `README-LINUX.txt` gives the one-time `chown`/`chmod` for distributions that restrict user namespaces; without it Electron refuses to start rather than run unsandboxed. No third-party packaging tool is needed.

The smoke command creates synthetic data in the selected application profile, loads the actual UI, checks renderer isolation and authenticated backend access, exports 30 frames at 1080 × 1920 through native HUD capture, and fully decodes the output. For isolated test data, invoke the built Electron executable with `desktop-dist --smoke --profile=/tmp/your-new-test-profile`. The profile contains `smoke.json`, the transparent `hud-smoke.png`, generated demo media and the finished test export.

`node scripts/test_desktop_server.mjs` checks the production backend's token, Host/Origin validation, CSP, path containment, request/range limits, separate library storage, original-byte preservation, and Python-free FIT/GPX import/deduplication. The application grants no Node access to the UI, rejects external navigation/new windows/webviews and denies permission requests. The backend listens only on loopback with a random token injected by the private Electron session.

Gitea verification is defined in `.gitea/workflows/verify.yml`: locked installation, TypeScript/client/desktop builds, Python references, importer parity, backend/widget/USB tests, full-decode export regressions a dependency audit and an enforced permissive-software license check (existing fonts retained). The build pins Vite 7.3.7 and uses its native JSX transform to keep non-font software dependencies within the permitted licenses. Public snapshots also carry `.github/workflows/verify.yml`, generated from the Gitea workflow when the snapshot is made, so the two run the same checks.

The Linux Gitea export tests run Chromium as an unprivileged user inside a disposable container. A CI-only launcher disables Chromium’s extra process sandbox because the Docker runner cannot create those namespaces; this launcher is not packaged or used by the application. The workflow also runs the Electron smoke under Xvfb, builds the Linux packages, checks the packaged setuid sandbox helper, smoke-tests the packaged binary, then installs the `.deb` with apt (resolving its dependencies) and smoke-tests the installed `/usr/bin/ride-studio`. These Electron runs pass `--no-sandbox` for the same container reason; the GPU-less runner exercises the `libx264` fallback. The default launchers never pass that flag, although a user can still add it by hand. Electron’s process sandbox is exercised only by manual runs: the macOS application smoke and the installed Linux `.deb` smoke recorded below. Every smoke checks that the UI has no Node access (`window.require` is undefined); context isolation itself is set in the window preferences rather than asserted by the smoke.

Tile attribution is fetched from the local backend for the UI and passed into each native HUD export, so a packaged app can change its configured provider without rebuilding its assets. The native smoke includes an entirely hidden map and checks the runtime attribution.

## Validation recorded on 30 October 2026 (Linux)

Manual, on Ubuntu 24.04 x64 with AppArmor user-namespace restriction, an NVIDIA RTX 3090 and the distribution FFmpeg 6.1.1: the development smoke, the installed `.deb` smoke (setuid sandbox active, no `--no-sandbox`) and the extracted archive smoke after its README step each completed the 30-frame 1080 × 1920 export with full decode, selecting `h264_nvenc`; `STUDIO_VIDEO_ENCODER=libx264` also passed. The extracted archive refused to start before its README step, as documented. A real ride (Varia Vue 2688 × 2160 HEVC front footage and an Edge FIT, imported through the TypeScript importer) exported three 10-second passages through the installed application: 900 frames, 30.0 s, 1080 × 1920 H.264/AAC in 71 s, full decode clean, HUD values identical to the FIT at the sampled times and the camera clock within one second of the FIT at both ends of the ride. The full Gitea workflow passed when run locally in its `node:24-trixie` container; it has not yet run on a Gitea or GitHub runner.

With the profile loaded, the installed application passed the smoke export with `--disable-setuid-sandbox` (it aborted with "No usable sandbox" before), ran under the `ride-studio` AppArmor label, put its zygote and renderers in their own user and PID namespaces, and never started `chrome-sandbox`. Removing the package unloaded and deleted the profile.

Second machine, same day: Ubuntu 26.04.1 (kernel 7.0, GNOME on Wayland, Intel UHD Graphics, AppArmor parser 5.0.2), run from a written test plan. `scripts/setup-linux.sh`, the four headless suites and the Electron smoke passed in the default, native Wayland (`--ozone-platform=wayland`) and X11 modes with no capture-size error. The installed `.deb` loaded the AppArmor profile, ran as `ride-studio (unconfined)` with renderers in their own user namespace and no setuid helper, and passed with `--disable-setuid-sandbox`. NVENC was unavailable (no `libcuda`), so exports used libx264. Chromium logs `vaInitialize failed` there without affecting export. Under a Wayland compositor the window's app_id is `ride-studio`, matching the desktop entry; the launcher icon and dock grouping were not checked visually.

Not validated after the Linux changes: macOS (the packaging refactor and Electron 44.10.0 need the macOS smoke and package rerun), Wayland compositors other than GNOME, Linux arm64, distributions other than Ubuntu 24.04/26.04 and Debian trixie, and VAAPI/Quick Sync hardware encoding (AMD/Intel use libx264).

## Validation recorded on 14 October 2026 (macOS and Linux CI, before the Linux desktop work)

A curated public snapshot was extracted into a fresh directory and passed `npm ci`, type checking, the software-license gate, the production desktop build, authenticated backend tests and the real Electron native export smoke. FIT and GPX HTTP imports were tested with an intentionally nonexistent Python executable, preserving uploaded bytes and FIT evidence. The packaged Apple-silicon `.app` passed the same 30-frame, 1080 × 1920 H.264/AAC export and full FFmpeg decode; its ad-hoc signature passed `codesign --verify --deep --strict`. The actual application UI and transparent HUD were visually inspected, including an entirely hidden route and custom runtime provider credit.

The full Gitea Linux verification ran successfully on both `main` and the curated release snapshot: all 78 Python tests completed with the macOS-only HEIC fixture skipped, all five importer/rounding parity suites passed, all backend/activity/camera/photo/media/USB/widget/export suites passed, and npm reported no vulnerabilities. The license gate accepts only the permitted software licenses and the retained existing font assets. This was clean-checkout validation on the existing Mac and Linux CI, not a claim of acceptance on a freshly installed macOS system or every supported hardware generation.
