// Developer packages using the pinned Electron runtime and the platform's own tools:
// macOS uses Apple's ditto/PlistBuddy/codesign; Linux uses tar and dpkg-deb; Windows uses the bundled tar for a zip.
// Avoids packaging dependencies outside the repository's permissive-license policy.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve('electron/package.json'));
const executable = require('electron');
// Proves the pinned runtime executes. On Linux, Node mode avoids starting Chromium's sandbox in containers.
if (process.platform !== 'darwin') await run(executable, ['--version'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
else await run(process.execPath, [join(electronRoot, 'cli.js'), '--version']);
const version = JSON.parse(readFileSync(join(studio, 'package.json'))).version;
// SemVer pre-releases (0.1.0-alpha.1): Debian sorts '~' before the final release and reserves '-' for the
// package revision; macOS bundle versions must be numeric.
const debVersion = version.replace('-', '~');
const bundleVersion = version.split('-')[0];

function copyElectronLicenses(destination) {
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const file = join(electronRoot, 'dist', name);
    if (!existsSync(file)) throw new Error(`Missing Electron runtime license: ${name}`);
    cpSync(file, join(destination, name === 'LICENSE' ? 'ELECTRON-LICENSE.txt' : name));
  }
}

async function packageMac() {
  const source = dirname(dirname(dirname(executable)));
  const out = join(studio, 'release', `Ride Studio-darwin-${process.arch}`);
  const app = join(out, 'Ride Studio.app');
  mkdirSync(out, { recursive: true });
  // This is our generated output only; original media/activity libraries are elsewhere.
  rmSync(app, { recursive: true, force: true });
  await run('/usr/bin/ditto', [source, app]);
  const contents = join(app, 'Contents');
  const plist = join(contents, 'Info.plist');
  for (const [key, value] of Object.entries({ CFBundleDisplayName: 'Ride Studio', CFBundleName: 'Ride Studio', CFBundleIdentifier: 'com.piotrgodlewski.ride-studio', CFBundleExecutable: 'Ride Studio', CFBundleShortVersionString: bundleVersion, CFBundleVersion: bundleVersion })) {
    await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  renameSync(join(contents, 'MacOS/Electron'), join(contents, 'MacOS/Ride Studio'));
  cpSync(join(studio, 'desktop-dist'), join(contents, 'Resources/app'), { recursive: true });
  copyElectronLicenses(join(contents, 'Resources'));
  // Ad-hoc signing fixes the copied bundle's local integrity; this is not Developer ID signing/notarization.
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  console.log(`Developer-alpha application: ${app}`);
  console.log('Ad-hoc signed for local testing; not Developer ID signed or notarized for distribution.');
}

// Ubuntu 23.10+ convention (as /etc/apparmor.d/chrome, code, signal-desktop): name the app and allow
// user namespaces so Chromium uses its preferred namespace sandbox; it adds no other confinement.
const APPARMOR_PROFILE = `# This profile allows everything and only exists to give the
# application a name instead of having the label "unconfined"

abi <abi/4.0>,
include <tunables/global>

profile ride-studio /usr/lib/ride-studio/ride-studio flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/ride-studio>
}
`;

// The profile is copied into /etc only where the kernel restricts user namespaces and the parser accepts
// it: older parsers (Ubuntu 22.04, Debian 12) reject abi 4.0 and userns, which would break boot-time reloads.
// Elsewhere the setuid chrome-sandbox remains the fallback.
const POSTINST = `#!/bin/sh
set -e
PROFILE=/etc/apparmor.d/ride-studio
SOURCE=/usr/share/ride-studio/apparmor/ride-studio
if [ "$1" = configure ]; then
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] &&
     [ -e /sys/kernel/security/apparmor/.load ] && command -v apparmor_parser >/dev/null 2>&1 &&
     apparmor_parser -QTK "$SOURCE" >/dev/null 2>&1; then
    install -m 0644 "$SOURCE" "$PROFILE"
    apparmor_parser -r -W -T "$PROFILE" || echo "ride-studio: could not load the AppArmor profile; the setuid sandbox helper will be used" >&2
  fi
fi
exit 0
`;

const PRERM = `#!/bin/sh
set -e
PROFILE=/etc/apparmor.d/ride-studio
if [ "$1" = remove ] || [ "$1" = deconfigure ]; then
  if [ -f "$PROFILE" ]; then
    if [ -e /sys/kernel/security/apparmor/.remove ] && command -v apparmor_parser >/dev/null 2>&1; then
      apparmor_parser -R "$PROFILE" || echo "ride-studio: could not unload the AppArmor profile" >&2
    fi
    rm -f "$PROFILE"
  fi
fi
exit 0
`;

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Ride Studio
GenericName=Telemetry Video Editor
Comment=Create cycling, running and hiking videos from camera footage and FIT/GPX activities
Exec=ride-studio
Icon=ride-studio
Terminal=false
Categories=AudioVideo;Video;AudioVideoEditing;
StartupWMClass=ride-studio
`;

async function packageLinux() {
  const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!debArch) throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  const release = join(studio, 'release');
  const name = `ride-studio-${version}-linux-${process.arch}`;
  const app = join(release, name);
  mkdirSync(release, { recursive: true });
  // This is our generated output only; original media/activity libraries are elsewhere.
  rmSync(app, { recursive: true, force: true });
  cpSync(dirname(executable), app, { recursive: true, verbatimSymlinks: true });
  renameSync(join(app, 'electron'), join(app, 'ride-studio'));
  rmSync(join(app, 'resources', 'default_app.asar'), { force: true });
  cpSync(join(studio, 'desktop-dist'), join(app, 'resources', 'app'), { recursive: true });
  // Window and taskbar icon; desktop environments use the scalable SVG from the .desktop entry.
  cpSync(join(studio, 'desktop/icon.png'), join(app, 'resources', 'app', 'icon.png'));
  cpSync(join(studio, 'desktop/icon.svg'), join(app, 'ride-studio.svg'));
  copyElectronLicenses(app);
  rmSync(join(app, 'LICENSE')); // Electron's, now ELECTRON-LICENSE.txt; the project license is in resources/app.
  // Normalize the build user's umask; an archive cannot carry root ownership, so its README explains the sandbox helper.
  await run('chmod', ['-R', 'u+rwX,go+rX,go-w', app]);
  chmodSync(join(app, 'chrome-sandbox'), 0o755);
  writeFileSync(join(app, 'README-LINUX.txt'), `Ride Studio ${version} developer alpha for Linux (${process.arch})

Run ./ride-studio. FFmpeg/FFprobe must be installed; ExifTool and Python 3 with
Pillow are needed for camera/photo/Apple Health metadata.

Distributions that restrict unprivileged user namespaces (Ubuntu 23.10 and later)
need Chromium's setuid sandbox helper configured once:

  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

The .deb package instead installs an AppArmor profile (and keeps this helper as
a fallback). Do not run with --no-sandbox.
`);
  const archive = join(release, `${name}.tar.gz`);
  await run('tar', ['--owner=0', '--group=0', '--numeric-owner', '-C', release, '-czf', archive, name]);

  // Debian package: /usr/lib/ride-studio, an AppArmor userns profile where needed, and the setuid helper as fallback.
  const root = join(release, `deb-${debArch}`);
  rmSync(root, { recursive: true, force: true });
  const lib = join(root, 'usr/lib/ride-studio');
  mkdirSync(dirname(lib), { recursive: true });
  cpSync(app, lib, { recursive: true, verbatimSymlinks: true });
  for (const extra of ['ride-studio.svg', 'README-LINUX.txt']) rmSync(join(lib, extra));
  mkdirSync(join(root, 'usr/bin'), { recursive: true });
  symlinkSync('../lib/ride-studio/ride-studio', join(root, 'usr/bin/ride-studio'));
  mkdirSync(join(root, 'usr/share/applications'), { recursive: true });
  writeFileSync(join(root, 'usr/share/applications/ride-studio.desktop'), DESKTOP_ENTRY);
  mkdirSync(join(root, 'usr/share/icons/hicolor/scalable/apps'), { recursive: true });
  cpSync(join(studio, 'desktop/icon.svg'), join(root, 'usr/share/icons/hicolor/scalable/apps/ride-studio.svg'));
  mkdirSync(join(root, 'usr/share/doc/ride-studio'), { recursive: true });
  // Debian Policy 12.5 requires the license at /usr/share/doc/<package>/copyright.
  cpSync(join(studio, '..', 'LICENSE'), join(root, 'usr/share/doc/ride-studio/copyright'));
  cpSync(join(studio, '..', 'THIRD_PARTY_NOTICES.md'), join(root, 'usr/share/doc/ride-studio/THIRD_PARTY_NOTICES.md'));
  mkdirSync(join(root, 'usr/share/ride-studio/apparmor'), { recursive: true });
  writeFileSync(join(root, 'usr/share/ride-studio/apparmor/ride-studio'), APPARMOR_PROFILE);
  await run('chmod', ['-R', 'u+rwX,go+rX,go-w', root]);
  chmodSync(join(lib, 'chrome-sandbox'), 0o4755);
  const installedKb = Number((await run('du', ['-sk', join(root, 'usr')])).stdout.split('\t')[0]);
  mkdirSync(join(root, 'DEBIAN'));
  writeFileSync(join(root, 'DEBIAN/control'), `Package: ride-studio
Version: ${debVersion}
Architecture: ${debArch}
Maintainer: Piotr Godlewski <pgodlews@users.noreply.github.com>
Installed-Size: ${installedKb}
Depends: ffmpeg, libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libxss1, libxtst6, libatspi2.0-0t64 | libatspi2.0-0, libsecret-1-0, libnotify4, libuuid1, xdg-utils
Recommends: libimage-exiftool-perl, python3-pil
Section: video
Priority: optional
Description: Local cycling and outdoor telemetry video studio (developer alpha)
 Create cycling, running and hiking videos from camera footage and FIT/GPX
 activities with a telemetry HUD. All processing stays on this computer.
`);
  for (const [script, text] of [['postinst', POSTINST], ['prerm', PRERM]]) {
    writeFileSync(join(root, 'DEBIAN', script), text);
    chmodSync(join(root, 'DEBIAN', script), 0o755);
  }
  const deb =join(release, `ride-studio_${debVersion}_${debArch}.deb`);
  await run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, deb]);
  rmSync(root, { recursive: true, force: true });
  console.log(`Developer-alpha application: ${app}`);
  console.log(`Archive: ${archive}`);
  console.log(`Debian package: ${deb}`);
  console.log('Unsigned developer builds for local testing.');
}

async function packageWindows() {
  const name = `ride-studio-${version}-win32-${process.arch}`;
  const release = join(studio, 'release');
  const app = join(release, name);
  mkdirSync(release, { recursive: true });
  // This is our generated output only; original media/activity libraries are elsewhere.
  rmSync(app, { recursive: true, force: true });
  cpSync(dirname(executable), app, { recursive: true });
  renameSync(join(app, 'electron.exe'), join(app, 'Ride Studio.exe'));
  rmSync(join(app, 'resources', 'default_app.asar'), { force: true });
  cpSync(join(studio, 'desktop-dist'), join(app, 'resources', 'app'), { recursive: true });
  // Window and taskbar icon while running; the .exe keeps Electron's file icon (no resource editing tool).
  cpSync(join(studio, 'desktop/icon.png'), join(app, 'resources', 'app', 'icon.png'));
  copyElectronLicenses(app);
  rmSync(join(app, 'LICENSE'), { force: true }); // Electron's, now ELECTRON-LICENSE.txt; the project license is in resources\app.
  writeFileSync(join(app, 'README-WINDOWS.txt'), `Ride Studio ${version} developer alpha for Windows (${process.arch})\r
\r
Extract the folder anywhere and run "Ride Studio.exe". The build is unsigned, so\r
Windows SmartScreen may warn on first launch: choose More info, then Run anyway.\r
\r
FFmpeg/FFprobe must be on PATH (winget install Gyan.FFmpeg) or selected through\r
STUDIO_FFMPEG/STUDIO_FFPROBE. Export needs the adelay all option; FFmpeg 6.1.1\r
passed Windows testing. Use Check setup to verify the installed build.\r
ExifTool and Python 3 with\r
Pillow and tzdata (requirements-runtime.txt) are needed for camera/photo/Apple\r
Health metadata; FIT and GPX need neither. Select Python in the File menu.\r
STUDIO_EXIFTOOL can select an ExifTool executable outside PATH.\r
`);
  const zip = join(release, `${name}.zip`);
  rmSync(zip, { force: true });
  // Windows 10+ ships bsdtar, which writes a zip from the archive's extension.
  await run('tar', ['-a', '-c', '-f', zip, '-C', release, name]);
  console.log(`Developer-alpha application: ${app}`);
  console.log(`Archive: ${zip}`);
  console.log('Unsigned developer build for local testing.');
}

if (process.platform === 'darwin') await packageMac();
else if (process.platform === 'linux') await packageLinux();
else if (process.platform === 'win32') await packageWindows();
else throw new Error(`Desktop packaging is not implemented for ${process.platform}`);
