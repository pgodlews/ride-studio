# Reproducible macOS FFmpeg build

These scripts build separate LGPL-only FFmpeg/FFprobe executables for future desktop packaging. The current developer alpha uses installed tools and does not include FFmpeg binaries.

The source is pinned to FFmpeg 8.1.3 and its expected SHA-256 in `build-macos.sh`. Both modes disable GPL/nonfree libraries, including libx264/libx265. The desktop encoder path uses Apple's `h264_videotoolbox`; the web developer reference still defaults to installed libx264 unless `STUDIO_VIDEO_ENCODER=h264_videotoolbox` is set.

On macOS with Xcode command-line tools:

```sh
ARCHES=arm64 packaging/ffmpeg/build-macos.sh full
python3 packaging/ffmpeg/verify-macos.py full
python3 packaging/ffmpeg/verify-privacy.py
```

Use `ARCHES="arm64 x86_64" UNIVERSAL=1` for a universal build. Outputs, downloaded source, configurations, toolchain records and license materials remain under ignored `build/` and `dist/`. Do not copy an installed Homebrew binary into a release package.

Before distributing the resulting executables, include their LGPL license and notices, complete corresponding source/build materials and a concrete source archive location. Preserve the exact configuration/toolchain/hash records and verify the actual packaged app against those executables. The current package script does not bundle them automatically. Codec patent considerations and distribution licensing need their own release review.

The integration runner also executes legacy fixture generators that request libx264; those generators need an encoder-aware update before that runner can validate the LGPL-only toolchain. The desktop application's native hardware export smoke is a separate check.
