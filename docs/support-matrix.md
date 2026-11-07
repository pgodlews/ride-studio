# Developer-alpha support matrix

| Area | Supported / verified | Limits |
| --- | --- | --- |
| Desktop | macOS Apple silicon; Linux x64 (Ubuntu 24.04 and 26.04 `.deb`/archive including GNOME Wayland, Debian trixie CI); Windows x64 experimental (CI and partial Windows 11 synthetic testing); production Electron UI, local library and native HUD export | Unsigned developer alpha; external media/metadata tools required; Linux hardware encode is NVENC only (VAAPI/Quick Sync pending); Intel/oldest macOS, Linux arm64/other distributions and Windows real-hardware acceptance pending |
| Activities | Single-session outdoor FIT and timestamped GPX with usable GPS | Indoor/GPS-free routes and multisport splitting excluded; unknown fields retained; missing channels remain missing |
| Phone / ordinary video | Import, browser preview conversion where needed, clock placement and manual map pin | Approximate sync; camera clock, trimming and long-clip drift need visual checks; no slow-motion/timelapse or HDR/log guarantee |
| Garmin front/rear | Original video and GLV preview, safe framing, explicit corrections, rear inset | Radar speeds exist in pixels; no structured radar time series/OCR implementation |
| DJI | Verified Avata embedded schema and named GPS SRT fields; fixture-tested Osmo schema | Other schemas and real Osmo GPS-remote validation pending; reframe 360 externally |
| GoPro | GPS5 validated on supplied HERO9/HERO10 samples; GPS9 implementation fixture-tested | Real GPS9 validation pending; poor/no fixes remain gaps; no native 360 handling |
| Still photos | EXIF time/GPS, orientation, editor placement and still/mixed exports | Python/Pillow/ExifTool helpers; HEIC conversion is macOS-specific |
| Apple Health | Local export.xml + route GPX scan/import of Watch workouts | Python helper remains; route required; overlapping Connect copies are not mixed in |
| Export | 30 fps H.264/AAC; 9:16, 16:9, 1:1, 4:5; shared preview/export widgets | Complete selected camera coverage required; gaps reject rather than shifting footage; no music added |
| Privacy | Configurable route start/finish trimming; no private fallback center | Entire route hidden when distances are unavailable or unusable; footage itself may still reveal locations |
| USB | Saved activity files; separate Chrome WebUSB workflow is read-only | WebUSB permissions are not enabled in the Electron alpha |

Compatibility is limited to the recording schemas and real-file checks stated here. Generated tests do not establish real-device validation for additional models. No source recordings or external test corpus are distributed in this snapshot.
