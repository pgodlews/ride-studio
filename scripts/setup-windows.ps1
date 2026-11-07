# Developer-alpha setup for Windows 10/11; winget (App Installer) must already be available.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
# Installs Node.js, Python, FFmpeg and ExifTool with winget, the repository Pillow/timezone environment,
# locked npm packages, then builds the desktop alpha.
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget not found. Install "App Installer" from the Microsoft Store, then rerun this script.'
}
foreach ($id in 'OpenJS.NodeJS.LTS', 'Python.Python.3.13', 'Gyan.FFmpeg', 'OliverBetz.ExifTool') {
  # Already-installed packages are left as they are.
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget install $id failed ($LASTEXITCODE)" }
}
# winget updates PATH for new shells only; pick up the new tools in this one.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

$nodeVersion = node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { throw 'Node.js could not start. Open a new terminal and rerun.' }
$version = $nodeVersion.Split('.')
if ([int]$version[0] -lt 22 -or ([int]$version[0] -eq 22 -and [int]$version[1] -lt 12)) {
  throw "Node.js 22.12 or later is required (found $($version -join '.')). Open a new terminal and rerun."
}

$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
  py -3.13 -m venv (Join-Path $Root '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
}
& $Python -m pip install -r (Join-Path $Root 'requirements-runtime.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
& $Python -c 'import PIL; from zoneinfo import ZoneInfo; ZoneInfo("Europe/London")'
if ($LASTEXITCODE -ne 0) { throw 'Python Pillow/timezone runtime check failed' }

npm --prefix (Join-Path $Root 'studio') ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
# npm may skip Electron's install script; fetch the pinned runtime explicitly.
$Electron = Join-Path $Root 'studio\node_modules\electron'
if (-not (Test-Path (Join-Path $Electron 'path.txt'))) {
  node (Join-Path $Electron 'install.js')
  if ($LASTEXITCODE -ne 0) { throw 'Electron installation failed' }
}

npm --prefix (Join-Path $Root 'studio') run desktop:build
if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' }
Write-Output 'Ready: cd studio; npm run desktop'
Write-Output 'Python helpers use the repository .venv. No Garmin SDK or private activity is needed.'
