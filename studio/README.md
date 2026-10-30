# Ride Studio application

See the [project quick start](../README.md), [desktop guide](../docs/desktop-alpha.md) and [support matrix](../docs/support-matrix.md).

`src/` contains the React editor, pure SVG widgets, shared telemetry model and platform-neutral importers. `server/` holds local import/media/export APIs. `desktop/` runs the production UI/backend in Electron and captures HUD frames without an external browser. `scripts/` contains builds, synthetic demos, test suites and the remaining Python metadata helpers/reference implementations.

```sh
npm ci
npm run typecheck
npm run desktop:build
npm run desktop
```

FIT/GPX uploads use TypeScript. Camera/photo/Apple Health helpers still require the external tools listed in the desktop guide. Python SDK-based files are developer references and are not redistributed third-party SDK code. Original inputs and generated outputs stay local; application builds explicitly exclude `public/data/`.
