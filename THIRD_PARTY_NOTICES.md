# Third-party notices

This project is MIT-licensed (see [LICENSE](LICENSE)). It includes or adapts the following third-party work, each under its own license.

## fit-file-parser

FIT activity decoding in the studio uses [fit-file-parser](https://github.com/jimmykane/fit-parser) (npm `fit-file-parser`), maintained by Dimitrios Kanellopoulos ([@jimmykane](https://github.com/jimmykane)) and contributors. It grew from Pierre Jacquier's [easy-fit](https://github.com/pierremtb/easy-fit), with an early prototype and binary handling from [@mlofjard](https://github.com/mlofjard/jsonfit)'s jsonfit.

```
The MIT License (MIT)

Copyright (c) 2015 Pierre Jacquier
http://pierrejacquier.com | @pierremtb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## exifr

Still-photo EXIF/GPS reading in the studio uses [exifr](https://github.com/MikeKovarik/exifr) (npm `exifr`), maintained by Mike Kovařík ([@MikeKovarik](https://github.com/MikeKovarik)). It replaces the ExifTool subprocess of the Python importer so photo metadata can be read in the browser, in Electron and in Node from the same code.

```
MIT License

Copyright (c) 2020 Mike Kovařík, Mutiny.cz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## saxes and xmlchars

The GPX and Apple Health importers in `studio/src/importers/` parse XML with [saxes](https://github.com/lddubeau/saxes) 6.0.0 (ISC), a fork of Isaac Z. Schlueter's [sax](https://github.com/isaacs/sax-js), and its dependency [xmlchars](https://github.com/lddubeau/xmlchars) 2.2.0 (MIT), both by Louis-Dominique Dubeau. The saxes npm package ships without a license file; the text below is from its repository.

```
The ISC License

Copyright (c) Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The following license is the one that governed sax, from which saxes
was forked.

The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

(same terms as above)
```

```
Copyright Louis-Dominique Dubeau and contributors to xmlchars

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Adapted code kept with its license

- **Packfade** (MIT): the read-only USB/MTP importer and WebUSB reader. See [telemetry-analysis/tools/PACKFADE-LICENSE](telemetry-analysis/tools/PACKFADE-LICENSE) and [studio/src/usb/PACKFADE-LICENSE](studio/src/usb/PACKFADE-LICENSE).
- **OSVplat** (MIT): DJI container traversal. See [studio/scripts/OSVPLAT-LICENSE](studio/scripts/OSVPLAT-LICENSE).

## Other dependencies

npm and Python packages keep their own license files in `node_modules/` and the Python environment. The studio's runtime npm dependencies are MIT, ISC, BSD-3-Clause and Apache-2.0 (including Puppeteer); its bundled fonts are SIL Open Font License 1.1. FFmpeg, ExifTool and Chrome are used as installed programs and are not distributed with this repository.

The direct studio dependencies below are pinned exactly (updated 30 October 2026: Electron 44.10.0 and puppeteer-core 25.16.0 for security advisories; Electron's transitive undici 7.30.1). The Vite 7 build toolchain uses its native JSX transform and avoids the MPL CSS dependency of Vite 8 and the additional Babel browser-data dependency. Package license files and copyright notices remain with the installed distributions; `studio/scripts/check_licenses.mjs` checks all locked package licenses, retaining only the existing font exception.

| Package | Version | Credit | License |
| --- | --- | --- | --- |
| `react`, `react-dom` | 19.3.0 | Meta and React contributors | MIT |
| `puppeteer-core` | 25.16.0 | The Chromium Authors | Apache-2.0 |
| `@puppeteer/browsers` | 3.2.3 | The Chromium Authors | Apache-2.0 |
| `exifr` | 7.1.3 | Mike Kovařík | MIT |
| `fit-file-parser` | 6.1.2 | Dimitrios Kanellopoulos and contributors; original authors credited above | MIT |
| `saxes` | 6.0.0 | Louis-Dominique Dubeau and contributors | ISC |
| `@types/node` | 26.6.4 | DefinitelyTyped contributors | MIT |
| `@types/react`, `@types/react-dom` | 19.3.0 | DefinitelyTyped contributors | MIT |
| `vite` | 7.3.7 | Evan You and Vite contributors | MIT |
| `typescript` | 7.0.2 | Microsoft and TypeScript contributors | Apache-2.0 |
| `@fontsource-variable/inter`, `@fontsource-variable/saira`, `@fontsource-variable/space-grotesk`, `@fontsource/barlow-condensed`, `@fontsource/bebas-neue` | 5.3.0 | Fontsource packaging; upstream font authors credited in each package's license | OFL-1.1 (existing font assets) |

Garmin's FIT SDK (`garmin-fit-sdk`) is used only by the Python research tools and tests, installed by each developer from Garmin's publication. Its license does not permit redistribution, so it is not included here.

## Desktop build tools and Electron runtime

- `electron` 44.10.0: Electron Community, MIT. Packaged applications retain Electron's LICENSE and Chromium third-party license materials supplied with the runtime.
- `rolldown` 1.2.12: Rolldown contributors, MIT; development bundler, including its platform bindings.
- Gitea checkout uses `actions/checkout` v4.2.2 at commit `11bd71901bbe5b1630ceea73d27597364c9af683` (GitHub and contributors, MIT). It is a CI tool, not bundled application code.

The desktop alpha invokes an installed FFmpeg/FFprobe distribution and does not redistribute it. macOS desktop export selects Apple's VideoToolbox H.264 encoder; the application package does not include libx264. Linux desktop export uses the distribution's FFmpeg, which the `.deb` declares as a dependency rather than bundling, selecting its NVENC encoder when the GPU can encode and its libx264 otherwise. Reproducible LGPL-only FFmpeg build recipes remain available under `packaging/ffmpeg/`; bundling those executables requires their matching source/build/license materials and a concrete release source archive location. Existing fonts are unchanged.

macOS developer packaging uses Apple’s installed `ditto`, `PlistBuddy` and `codesign` tools and the pinned Electron runtime. Linux developer packaging uses the system `tar` and `dpkg-deb`, with the project's own application icon (`studio/desktop/icon.svg` and its 512 px PNG rendering, MIT with the project). Windows developer packaging uses the `tar` built into Windows 10 and later. No third-party packaging dependency is required. Packaged applications include `ELECTRON-LICENSE.txt` and `LICENSES.chromium.html` from the exact Electron runtime distribution; the `.deb` also installs the project license and these notices under `/usr/share/doc/ride-studio`.

- `esbuild` 0.28.2: Evan Wallace and contributors, MIT; Vite’s build-time JavaScript/JSX transform.
- `rollup` 4.64.6: Rollup contributors, MIT; Vite’s build-time bundler.
