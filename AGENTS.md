# Agent guide

Read `README.md`, `docs/desktop-alpha.md`, `docs/support-matrix.md` and `THIRD_PARTY_NOTICES.md` before changing the application. This is a curated public source snapshot; private research inputs/history are not included.

Preserve original media and activities. Device import must stay read-only. Never stage raw FIT/GPX data, GPS traces, credentials, manifests, generated media or dependency/build caches. Demo fixtures must be clearly synthetic and generated from code.

Keep UTC timestamps and per-clip synchronization corrections explicit. Prefer enhanced FIT speed/altitude. Preserve real zero cadence, and keep missing/invalid/nonfinite readings missing. Do not invent mappings for unknown FIT fields or claim unvalidated camera compatibility. No copied or reverse-engineered proprietary Garmin SDK implementation is permitted.

Dependencies must be exactly pinned and credited. Use permissive software dependencies; existing font assets retain their own licenses. Keep FFmpeg as a separate executable and include the corresponding build/source/license materials when distributing its LGPL build.

Run `npm --prefix studio run typecheck` and the affected tests/builds. Changes to importer ports or Python references must keep the `studio/scripts/test_*_port.mjs` parity suites green with `STUDIO_PYTHON` pointing at the reference environment. Export changes need dimensions/codecs/frame count/duration/audio checks and full FFmpeg decoding. Keep documentation honest about alpha limitations.
