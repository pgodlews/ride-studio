#!/bin/bash
# Build FFmpeg's LGPL CLI tools; never install anything system-wide.
set -euo pipefail
export LC_ALL=C TZ=UTC
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
MODE=${1:-full}
ARCHES=${ARCHES:-"arm64 x86_64"}
JOBS=${JOBS:-8}
MACOS_MIN=${MACOS_MIN:-13.0}
UNIVERSAL=${UNIVERSAL:-0}
case "$MODE" in full|trimmed) ;; *) echo "Usage: $0 [full|trimmed]" >&2; exit 2 ;; esac
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS with Xcode command-line tools required' >&2; exit 1; }
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { echo 'JOBS must be a positive integer' >&2; exit 2; }
for arch in $ARCHES; do
  case "$arch" in arm64|x86_64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 2 ;; esac
done
# A controlled PATH and empty pkg-config prevent accidental Homebrew linkage.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CFLAGS CPPFLAGS LDFLAGS CXXFLAGS CPATH LIBRARY_PATH SDKROOT MACOSX_DEPLOYMENT_TARGET
unset C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH PKG_CONFIG_PATH PKG_CONFIG_LIBDIR
SDK=$(xcrun --sdk macosx --show-sdk-path)
SDK_VERSION=$(xcrun --sdk macosx --show-sdk-version)
mkdir -p "$ROOT/build/downloads" "$ROOT/build/tmp" "$ROOT/dist/$MODE"
export TMPDIR="$ROOT/build/tmp"
TARBALL="$ROOT/build/downloads/ffmpeg-$VERSION.tar.xz"
if [[ ! -f "$TARBALL" ]]; then
  curl --fail --location --retry 3 "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$TARBALL.part"
  mv "$TARBALL.part" "$TARBALL"
fi
printf '%s  %s\n' "$SHA256" "$TARBALL" | shasum -a 256 -c -
SOURCE="$ROOT/build/ffmpeg-$VERSION"
if [[ ! -d "$SOURCE" ]]; then tar -xJf "$TARBALL" -C "$ROOT/build"; fi
# Detect edited/corrupted cached sources without discarding someone's work.
if [[ ! -f "$ROOT/build/source.sha256" ]]; then
  (cd "$SOURCE"; find . -type f -exec shasum -a 256 {} + | sort) > "$ROOT/build/source.sha256"
fi
(cd "$SOURCE"; shasum -a 256 -c "$ROOT/build/source.sha256" > "$ROOT/build/source-check.log")

for arch in $ARCHES; do
  build="$ROOT/build/$MODE-$arch"
  dist="$ROOT/dist/$MODE/$arch"
  mkdir -p "$build" "$dist"
  # Each flag is intentionally scoped; see README for feature inventory.
  flags=(
    --prefix=/                            # No make install; only copy CLI binaries locally.
    --target-os=darwin                    # Both slices use Apple's Mach-O ABI.
    --enable-cross-compile                # Do not execute target probes on the build host.
    --cc=/usr/bin/clang                   # Xcode toolchain, not an ambient package manager.
    --cxx=/usr/bin/clang++                # Same toolchain if C++ is ever selected.
    --pkg-config=/usr/bin/false           # No third-party package discovery.
    --disable-autodetect                  # Explicit opt-in to system compression/frameworks.
    --disable-gpl                        # Exclude GPL components/optimizations.
    --disable-nonfree                    # Exclude unredistributable combinations.
    --disable-version3                   # Keep LGPL v2.1+; no required v3 component.
    --enable-static                      # FFmpeg archives linked inside each CLI executable.
    --disable-shared                     # No bundled libav*.dylib or external FFmpeg runtime.
    --disable-debug                      # Reduce executable size; preserve rebuild recipe.
    --disable-doc                        # No generated documentation tools required.
    --disable-ffplay                     # Ship ffmpeg/ffprobe, no SDL player.
    --enable-ffmpeg                      # Transcoding CLI.
    --enable-ffprobe                     # JSON stream/format/packet inspection.
    --enable-videotoolbox                # Native H.264/HEVC encode and hardware decode.
    --enable-audiotoolbox                # Apple's audio codecs, system frameworks only.
    --enable-zlib                        # System libz: required for PNG HUD/still streams.
    --enable-bzlib                       # System libbz2: compressed internal formats.
    --disable-lzma                       # Apple SDK lacks lzma headers; no external dependency.
    --enable-iconv                       # System libiconv: text conversion.
    --extra-libs=-liconv                  # Explicit system link; SDK probe alone missed final symbols.
    "--extra-cflags=-arch $arch -isysroot $SDK -mmacosx-version-min=$MACOS_MIN -ffile-prefix-map=src=ffmpeg-$VERSION"
                                         # Relative source map; no checkout path in buildconf.
    "--extra-ldflags=-arch $arch -isysroot $SDK -mmacosx-version-min=$MACOS_MIN"
                                         # Match compiler target at final link.
  )
  if [[ "$arch" == arm64 ]]; then flags+=(--arch=aarch64); else
    flags+=(--arch=x86_64 --disable-x86asm) # No nasm download; C/inlined asm remains, slower Intel decode.
  fi
  if [[ "$MODE" == trimmed ]]; then
    flags+=(
      --disable-everything               # Then opt into local camera/photo/export/test formats.
      --disable-network                  # Studio opens local files/pipes; no remote ingestion.
      --enable-avcodec --enable-avformat --enable-avfilter --enable-swscale --enable-swresample
                                         # Codec, container, graph, scale and audio conversions.
      --enable-indev=lavfi               # Generated testsrc2/sine fixtures.
      --enable-protocol=file,pipe        # Originals, concat lists, stdin HUD/raw and stdout progress.
      --enable-demuxer=mov,matroska,avi,mpegts,aac,mp3,wav,flac,ogg,image2,image2pipe,image_png_pipe,image_jpeg_pipe,image_webp_pipe,image_tiff_pipe,rawvideo,concat
                                         # Camera MOV/MP4/M4V/GLV/OSV/LRF; common extra local formats.
      --enable-decoder=h264,hevc,aac,aac_latm,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_f64le,alac,mp3,mp3float,flac,opus,vorbis,mpeg4,mpeg2video,mjpeg,png,webp,tiff,bmp,gif,prores,vp8,vp9,av1,rawvideo,wrapped_avframe
                                         # Software camera/phone decode including rear PCM and stills.
      --enable-parser=h264,hevc,aac,aac_latm,mpegaudio,mpeg4video,mpegvideo,mjpeg,png,vp8,vp9,av1,opus,vorbis,flac
                                         # Packet/frame parsing and probe codec identification.
      --enable-encoder=h264_videotoolbox,hevc_videotoolbox,aac,mpeg4,mjpeg,png,rawvideo,pcm_s16le,pcm_f32le,wrapped_avframe
                                         # Shipping H.264/AAC, posters, raw/RMS/null validation; no MP3 encoder.
      --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox
                                         # Repository's explicit VideoToolbox decode request.
      --enable-muxer=mp4,mov,matroska,avi,mpegts,image2,image2pipe,rawvideo,pcm_f32le,wav,null
                                         # Export/fixtures/posters/raw pipes/audio tests/full decode.
      --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata
                                         # Common container/bitstream conversions.
      --enable-filter=crop,scale,setsar,fps,trim,setpts,overlay,format,concat,tpad,drawbox,null,aresample,aformat,atrim,asetpts,anullsrc,highpass,lowpass,volume,apad,afade,adelay,testsrc2,sine,transpose,hflip,vflip,anull,hwdownload
                                         # LGPL graphs, test sources, autorotation; legacy eq is GPL.
    )
  fi
  printf '%s\n' "${flags[@]}" > "$build/configure-args.pending"
  { printf 'FFmpeg %s\nSDK %s\nminimum macOS %s\n' "$VERSION" "$SDK_VERSION" "$MACOS_MIN"; xcrun clang --version; } > "$build/toolchain.pending"
  if [[ ! -f "$build/configure-args.txt" ]] || ! cmp -s "$build/configure-args.pending" "$build/configure-args.txt" || ! cmp -s "$build/toolchain.pending" "$build/toolchain.txt"; then
    # Reject incompatible stale objects instead of silently mixing toolchains.
    [[ ! -f "$build/Makefile" ]] || (cd "$build"; make distclean > distclean.log 2>&1)
    # FFmpeg natively uses relative SRC_PATH=src when this link exists before
    # configure. No source patches or absolute compiler prefix maps are needed.
    if [[ -L "$build/src" ]]; then rm "$build/src"; fi
    [[ ! -e "$build/src" ]] || { echo 'Unexpected non-symlink build/src' >&2; exit 1; }
    ln -s "../ffmpeg-$VERSION" "$build/src"
    if ! (cd "$build"; ./src/configure "${flags[@]}" > configure.log 2>&1); then
      echo "Configure failed: build/$MODE-$arch/configure.log" >&2
      tail -12 "$build/configure.log" >&2
      exit 1
    fi
    mv "$build/configure-args.pending" "$build/configure-args.txt"
    mv "$build/toolchain.pending" "$build/toolchain.txt"
  fi
  # Machine-readable assertions complement configure's printed license.
  for define in GPL NONFREE VERSION3; do
    grep -qx "#define CONFIG_${define} 0" "$build/config.h"
  done
  grep 'License: LGPL version 2.1 or later' "$build/configure.log"
  echo "Building $MODE $arch ($JOBS jobs); log: build/$MODE-$arch/make.log"
  if ! (cd "$build"; make -j "$JOBS" ffmpeg ffprobe > make.log 2>&1); then
    echo "Compilation failed: build/$MODE-$arch/make.log" >&2
    tail -20 "$build/make.log" >&2
    exit 1
  fi
  for tool in ffmpeg ffprobe; do
    cp "$build/$tool" "$dist/$tool"
    strip -S -x "$dist/$tool"
    codesign --force -s - --options runtime "$dist/$tool"
    codesign --verify --strict "$dist/$tool"
    strings -a "$dist/$tool" > "$build/$tool.strings.txt"
    for needle in "/$(printf '%s' Users)/" "${HOME##*/}"; do
      if grep -Fq -- "$needle" "$build/$tool.strings.txt"; then
        echo "Personal path/name found in $MODE/$arch/$tool" >&2
        exit 1
      fi
    done
    lipo -archs "$dist/$tool" | grep -qx "$arch"
    otool -L "$dist/$tool" > "$dist/$tool.dependencies.txt"
    # All dynamically loaded install names must be Apple system locations.
    awk 'NR > 1 { if ($1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\//) bad=1 } END { exit bad }' "$dist/$tool.dependencies.txt"
  done
  cp "$build/configure-args.txt" "$build/toolchain.txt" "$build/config.h" "$dist/"
  cp "$SOURCE/COPYING.LGPLv2.1" "$SOURCE/LICENSE.md" "$dist/"
  (cd "$dist"; shasum -a 256 ffmpeg ffprobe > SHA256SUMS; wc -c ffmpeg ffprobe)
done
# Host source separately alongside the binary distribution, with this exact recipe.
mkdir -p "$ROOT/dist/$MODE/source"
cp "$TARBALL" "$ROOT/dist/$MODE/source/"
cp "$ROOT/build/source.sha256" "$ROOT/dist/$MODE/source/"
cp "$ROOT/build-macos.sh" "$ROOT/dist/$MODE/source/"
printf 'Unmodified upstream release; no source patches. SHA256 %s\n' "$SHA256" > "$ROOT/dist/$MODE/source/changes.txt"
for arch in $ARCHES; do
  mkdir -p "$ROOT/dist/$MODE/source/$arch"
  cp "$ROOT/dist/$MODE/$arch/configure-args.txt" "$ROOT/dist/$MODE/$arch/toolchain.txt" "$ROOT/dist/$MODE/source/$arch/"
done
if [[ "$UNIVERSAL" == 1 ]]; then
  mkdir -p "$ROOT/dist/$MODE/universal"
  for tool in ffmpeg ffprobe; do
    lipo -create "$ROOT/dist/$MODE/arm64/$tool" "$ROOT/dist/$MODE/x86_64/$tool" -output "$ROOT/dist/$MODE/universal/$tool"
    codesign --force -s - --options runtime "$ROOT/dist/$MODE/universal/$tool"
    codesign --verify --strict "$ROOT/dist/$MODE/universal/$tool"
    strings -a "$ROOT/dist/$MODE/universal/$tool" > "$ROOT/build/$MODE-$tool-universal.strings.txt"
    for needle in "/$(printf '%s' Users)/" "${HOME##*/}"; do
      if grep -Fq -- "$needle" "$ROOT/build/$MODE-$tool-universal.strings.txt"; then
        echo "Personal path/name found in $MODE/universal/$tool" >&2
        exit 1
      fi
    done
    lipo -archs "$ROOT/dist/$MODE/universal/$tool"
    otool -arch all -L "$ROOT/dist/$MODE/universal/$tool" > "$ROOT/dist/$MODE/universal/$tool.dependencies.txt"
    awk '/^\t/ { if ($1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\//) bad=1 } END { exit bad }' "$ROOT/dist/$MODE/universal/$tool.dependencies.txt"
  done
  cp "$SOURCE/COPYING.LGPLv2.1" "$SOURCE/LICENSE.md" "$ROOT/dist/$MODE/universal/"
  (cd "$ROOT/dist/$MODE/universal"; shasum -a 256 ffmpeg ffprobe > SHA256SUMS; wc -c ffmpeg ffprobe)
fi
