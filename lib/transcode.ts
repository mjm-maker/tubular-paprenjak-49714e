/**
 * Lazy ffmpeg.wasm transcode, used only as a last resort.
 *
 * Browsers that can neither encode H.264 via WebCodecs nor record `video/mp4`
 * through MediaRecorder (older Firefox, mainly) still produce a perfectly good
 * WebM. Rather than handing the user a file the social apps will reject, that WebM
 * is remuxed to H.264/AAC MP4 here.
 *
 * The single-threaded ffmpeg core is used deliberately: it does not need
 * SharedArrayBuffer, so the site does not have to be served with COOP/COEP
 * headers (which would break the CDN-hosted core load in the first place).
 */

const CORE_VERSION = '0.12.6';
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

export function transcodeAvailable(): boolean {
  return typeof WebAssembly !== 'undefined';
}

export async function transcodeToMp4(
  input: Blob,
  onProgress: (ratio: number) => void,
): Promise<Blob> {
  const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ]);

  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (Number.isFinite(progress)) onProgress(Math.min(1, Math.max(0, progress)));
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  try {
    await ffmpeg.writeFile('input.webm', new Uint8Array(await input.arrayBuffer()));
    const exitCode = await ffmpeg.exec([
      '-i',
      'input.webm',
      // Both streams are mapped by name. Left to its own stream selection, ffmpeg will
      // still write a perfectly valid video-only MP4 if anything is odd about the audio
      // stream, and a silent file that converted "successfully" is the worst outcome
      // here — asking for the track explicitly makes its absence an error instead.
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '24',
      // Main profile at level 4.0 with 4:2:0 chroma is the safest combination for
      // playback on older phones and is what every social app expects.
      '-profile:v',
      'main',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      // moov atom up front so the file starts playing before it is fully buffered.
      '-movflags',
      '+faststart',
      'output.mp4',
    ]);
    if (exitCode !== 0) {
      throw new Error('The converter could not produce an MP4 with both picture and sound.');
    }

    const data = await ffmpeg.readFile('output.mp4');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
  } finally {
    ffmpeg.terminate();
  }
}
