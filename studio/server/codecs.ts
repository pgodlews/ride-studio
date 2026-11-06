import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Installed tools for development; desktop can point to a separately bundled LGPL build. */
export const ffmpegPath = () => process.env.STUDIO_FFMPEG ?? 'ffmpeg';
export const ffprobePath = () => process.env.STUDIO_FFPROBE ?? 'ffprobe';
export const decodeArgs = () => process.platform === 'darwin' ? ['-hwaccel', 'videotoolbox'] : [];

export function h264Args(preview = false, encoder = process.env.STUDIO_VIDEO_ENCODER ?? 'libx264'): string[] {
  if (encoder === 'h264_videotoolbox') return ['-c:v', encoder, '-b:v', preview ? '4M' : '12M', '-maxrate', '20M', '-bufsize', '40M'];
  if (encoder === 'h264_qsv') return ['-c:v', encoder, '-preset', preview ? 'veryfast' : 'medium', '-global_quality', preview ? '26' : '20', '-look_ahead', '0'];
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', preview ? 'speed' : 'balanced', '-rc', 'vbr_peak', '-b:v', preview ? '4M' : '12M', '-maxrate', '20M', '-bufsize', '40M'];
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', preview ? 'p2' : 'p5', '-rc', 'vbr', '-cq', preview ? '24' : '19', '-b:v', '0', '-maxrate', '20M', '-bufsize', '40M'];
  if (encoder === 'libx264') return ['-c:v', encoder, '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '24' : '19', '-maxrate', '20M', '-bufsize', '40M'];
  throw new Error(`Unsupported STUDIO_VIDEO_ENCODER: ${encoder}`);
}

// Hardware H.264 encoders tried in order; VAAPI is not wired in on Linux (it needs hardware-upload filters).
const HARDWARE_ENCODERS: Partial<Record<NodeJS.Platform, string[]>> = { linux: ['h264_nvenc'], win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'] };

/** First hardware encoder that completes a short probe encode with the real export settings; an FFmpeg build listing an encoder proves nothing about the GPU/driver. */
export async function detectHardwareEncoder(platform = process.platform): Promise<string> {
  for (const encoder of HARDWARE_ENCODERS[platform] ?? []) {
    try {
      await promisify(execFile)(ffmpegPath(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=1080x1920:rate=30:duration=0.2', '-pix_fmt', 'yuv420p', ...h264Args(false, encoder), '-profile:v', 'high', '-level', '4.2', '-f', 'null', '-'], { timeout: 15000 });
      return encoder;
    } catch { /* try the next encoder */ }
  }
  return 'libx264';
}

/** Check the audio-delay option used by every export before starting HUD capture. */
export async function checkExportCapabilities(): Promise<void> {
  try {
    await promisify(execFile)(ffmpegPath(), ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
      'anullsrc=r=48000:cl=stereo', '-af', 'adelay=0:all=1', '-t', '0.01', '-f', 'null', '-'], { timeout: 10000 });
  } catch {
    throw new Error('FFmpeg is unavailable or incompatible: export requires the adelay all option. Install a current FFmpeg build (6.1.1 passed Windows testing), or set STUDIO_FFMPEG to a compatible executable. Run Check setup in Ride Studio.');
  }
}
