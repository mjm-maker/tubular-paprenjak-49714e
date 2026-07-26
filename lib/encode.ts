/**
 * Real MP4 generation, in the browser.
 *
 * Three pipelines are tried in order, best first. All of them produce H.264 video +
 * AAC audio in an MP4 container with the moov atom at the front, which is what
 * TikTok, Instagram Reels, Facebook Reels and YouTube Shorts all expect:
 *
 *  1. `webcodecs`  — encode frame-by-frame with VideoEncoder/AudioEncoder and mux
 *                    with mp4-muxer. Runs faster than real time, gives exact frame
 *                    timing, and never drops frames. Chrome, Edge, Safari 16.4+.
 *  2. `mediarecorder` — record a canvas + audio stream straight to `video/mp4`.
 *                    Real time (a 40s clip takes 40s) but hardware accelerated.
 *  3. `ffmpeg`     — record WebM, then transcode to H.264/AAC with ffmpeg.wasm.
 *                    Slow, but it means even browsers without an MP4 encoder end
 *                    up with an uploadable file.
 */

import {
  FPS,
  getFrameData,
  type AudioAnalysis,
} from './analysis';
import { drawFrame, type RenderSpec } from './render';
import { VIDEO_HEIGHT, VIDEO_WIDTH } from './theme';

export type Pipeline = 'webcodecs' | 'mediarecorder' | 'ffmpeg';

export type EncodeStage = 'render' | 'record' | 'convert' | 'package';

export interface EncodeProgress {
  stage: EncodeStage;
  /** 0..1 within the current stage. */
  ratio: number;
  detail: string;
}

export interface EncodeResult {
  blob: Blob;
  mimeType: string;
  pipeline: Pipeline;
  /** Wall-clock milliseconds the export took. */
  elapsedMs: number;
}

export interface EncodeOptions {
  audioBuffer: AudioBuffer;
  analysis: AudioAnalysis;
  spec: RenderSpec;
  onProgress: (progress: EncodeProgress) => void;
  signal?: AbortSignal;
}

const AUDIO_BITRATE = 128_000;

/**
 * Well inside every platform's ceiling, and stepped down for longer clips so the
 * in-memory MP4 stays a size a phone browser can actually hold.
 */
function videoBitrateFor(durationSeconds: number): number {
  if (durationSeconds > 120) return 3_800_000;
  if (durationSeconds > 60) return 4_600_000;
  return 5_500_000;
}

/** H.264 High/Main/Baseline at level 4.0-4.2, widest-support first. */
const H264_CODECS = ['avc1.640028', 'avc1.4D0028', 'avc1.42E028', 'avc1.64002A'];
const MP4_RECORDER_MIMES = [
  'video/mp4;codecs="avc1.4d0028,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E028,mp4a.40.2"',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
];
const WEBM_RECORDER_MIMES = [
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  'video/webm',
];

class AbortError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'AbortError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** Make sure webfonts are ready before any text is painted into a frame. */
async function waitForFonts(): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is a nicety; a fallback family still renders.
  }
}

// --- pipeline 1: WebCodecs ------------------------------------------------

function webCodecsAvailable(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined'
  );
}

async function pickVideoConfig(bitrate: number): Promise<VideoEncoderConfig | null> {
  for (const codec of H264_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      bitrate,
      framerate: FPS,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return (support.config as VideoEncoderConfig) ?? config;
    } catch {
      // Try the next codec string.
    }
  }
  return null;
}

async function pickAudioConfig(
  sampleRate: number,
  numberOfChannels: number,
): Promise<AudioEncoderConfig | null> {
  const config: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels,
    bitrate: AUDIO_BITRATE,
  };
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    if (support.supported) return (support.config as AudioEncoderConfig) ?? config;
  } catch {
    // Fall through.
  }
  return null;
}

async function encodeWithWebCodecs(options: EncodeOptions): Promise<Blob | null> {
  const { audioBuffer, analysis, spec, onProgress, signal } = options;
  if (!webCodecsAvailable()) return null;

  const channels = Math.min(2, audioBuffer.numberOfChannels);
  const [videoConfig, audioConfig] = await Promise.all([
    pickVideoConfig(videoBitrateFor(analysis.duration)),
    pickAudioConfig(audioBuffer.sampleRate, channels),
  ]);
  if (!videoConfig || !audioConfig) return null;

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    video: { codec: 'avc', width: VIDEO_WIDTH, height: VIDEO_HEIGHT, frameRate: FPS },
    audio: {
      codec: 'aac',
      numberOfChannels: audioConfig.numberOfChannels,
      sampleRate: audioConfig.sampleRate,
    },
  });

  let failure: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(VIDEO_WIDTH, VIDEO_HEIGHT)
      : Object.assign(document.createElement('canvas'), {
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
        });
  const ctx = canvas.getContext('2d', { alpha: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;

  const checkFailure = () => {
    if (failure) throw failure;
  };

  try {
    videoEncoder.configure(videoConfig);
    audioEncoder.configure(audioConfig);

    // --- audio first: cheap, and it keeps the video loop uninterrupted --------
    const chunkFrames = 4096;
    const totalFrames = audioBuffer.length;
    const planar = new Float32Array(chunkFrames * channels);
    for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
      throwIfAborted(signal);
      checkFailure();
      const frames = Math.min(chunkFrames, totalFrames - offset);
      const view = frames === chunkFrames ? planar : new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) {
        view.set(audioBuffer.getChannelData(c).subarray(offset, offset + frames), c * frames);
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: audioBuffer.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((offset / audioBuffer.sampleRate) * 1_000_000),
        data: view,
      });
      audioEncoder.encode(data);
      data.close();

      while (audioEncoder.encodeQueueSize > 24) {
        throwIfAborted(signal);
        checkFailure();
        await sleep(2);
      }
    }

    // --- then every video frame ---------------------------------------------
    const frameCount = analysis.frameCount;
    const microsecondsPerFrame = 1_000_000 / FPS;
    for (let index = 0; index < frameCount; index++) {
      throwIfAborted(signal);
      checkFailure();

      drawFrame(ctx, getFrameData(analysis, index), spec, index, 1);
      const frame = new VideoFrame(canvas as CanvasImageSource, {
        timestamp: Math.round(index * microsecondsPerFrame),
        duration: Math.round(microsecondsPerFrame),
      });
      // A keyframe every two seconds keeps seeking snappy in social feeds.
      videoEncoder.encode(frame, { keyFrame: index % (FPS * 2) === 0 });
      frame.close();

      while (videoEncoder.encodeQueueSize > 8) {
        throwIfAborted(signal);
        checkFailure();
        await sleep(2);
      }

      if (index % 5 === 0) {
        onProgress({
          stage: 'render',
          ratio: index / frameCount,
          detail: `Encoding frame ${index + 1} of ${frameCount}`,
        });
        // Hand the main thread back so the progress bar actually moves.
        await sleep(0);
      }
    }

    onProgress({ stage: 'package', ratio: 0.9, detail: 'Writing the MP4 container' });
    await videoEncoder.flush();
    await audioEncoder.flush();
    checkFailure();
    muxer.finalize();

    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    for (const encoder of [videoEncoder, audioEncoder]) {
      if (encoder.state !== 'closed') {
        try {
          encoder.close();
        } catch {
          // Already torn down.
        }
      }
    }
  }
}

// --- pipelines 2 & 3: MediaRecorder --------------------------------------

function pickRecorderMime(candidates: string[]): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/**
 * Play the audio through a MediaStream while a canvas is painted in real time, and
 * record both into one file.
 */
async function recordRealtime(options: EncodeOptions, mimeType: string): Promise<Blob> {
  const { audioBuffer, analysis, spec, onProgress, signal } = options;

  const canvas = document.createElement('canvas');
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot draw to a canvas.');

  // Paint frame zero so the stream never starts on a blank canvas.
  drawFrame(ctx, getFrameData(analysis, 0), spec, 0, 1);

  const audioContext = new AudioContext({ sampleRate: audioBuffer.sampleRate });
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);

  const stream = canvas.captureStream(FPS);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: videoBitrateFor(analysis.duration),
    audioBitsPerSecond: AUDIO_BITRATE,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Recording the video stream failed.'));
  });

  let rafHandle = 0;
  let finished = false;
  const cleanup = () => {
    finished = true;
    cancelAnimationFrame(rafHandle);
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    for (const track of stream.getTracks()) track.stop();
    void audioContext.close();
  };

  const onAbort = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    await audioContext.resume();
    recorder.start(1000);
    const startedAt = audioContext.currentTime;
    source.start();
    let lastReport = -1;

    const paint = () => {
      if (finished) return;
      const elapsed = audioContext.currentTime - startedAt;
      const index = Math.min(analysis.frameCount - 1, Math.max(0, Math.round(elapsed * FPS)));
      drawFrame(ctx, getFrameData(analysis, index), spec, index, 1);
      // Roughly ten updates a second: enough to look live, few enough that React
      // re-rendering the progress bar does not compete with the capture itself.
      if (elapsed - lastReport >= 0.1) {
        lastReport = elapsed;
        onProgress({
          stage: 'record',
          ratio: Math.min(1, elapsed / Math.max(0.001, analysis.duration)),
          detail: 'Recording in real time — keep this tab visible',
        });
      }
      if (elapsed >= analysis.duration) {
        // Small tail so the encoder flushes the final frames.
        setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, 220);
        return;
      }
      rafHandle = requestAnimationFrame(paint);
    };
    rafHandle = requestAnimationFrame(paint);

    await stopped;
    throwIfAborted(signal);
    return new Blob(chunks, { type: recorder.mimeType || mimeType });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanup();
  }
}

// --- orchestration -------------------------------------------------------

export function describePipeline(pipeline: Pipeline): string {
  switch (pipeline) {
    case 'webcodecs':
      return 'Hardware H.264 encode (WebCodecs)';
    case 'mediarecorder':
      return 'Real-time MP4 capture (MediaRecorder)';
    case 'ffmpeg':
      return 'WebM capture converted with ffmpeg';
  }
}

/** Returns true when this browser can produce an MP4 by some route. */
export function canExportMp4(): boolean {
  return (
    webCodecsAvailable() ||
    pickRecorderMime(MP4_RECORDER_MIMES) !== null ||
    (pickRecorderMime(WEBM_RECORDER_MIMES) !== null && typeof WebAssembly !== 'undefined')
  );
}

export async function encodeVideo(options: EncodeOptions): Promise<EncodeResult> {
  const startedAt = now();
  throwIfAborted(options.signal);
  await waitForFonts();

  // 1. WebCodecs.
  options.onProgress({ stage: 'render', ratio: 0, detail: 'Preparing the encoder' });
  let webCodecsError: unknown = null;
  try {
    const blob = await encodeWithWebCodecs(options);
    if (blob && blob.size > 0) {
      return { blob, mimeType: 'video/mp4', pipeline: 'webcodecs', elapsedMs: now() - startedAt };
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    webCodecsError = error;
  }

  // 2. MediaRecorder straight to MP4.
  const mp4Mime = pickRecorderMime(MP4_RECORDER_MIMES);
  if (mp4Mime) {
    options.onProgress({ stage: 'record', ratio: 0, detail: 'Starting real-time capture' });
    const blob = await recordRealtime(options, mp4Mime);
    if (blob.size > 0) {
      return {
        blob,
        mimeType: blob.type || 'video/mp4',
        pipeline: 'mediarecorder',
        elapsedMs: now() - startedAt,
      };
    }
  }

  // 3. WebM capture, then convert.
  const webmMime = pickRecorderMime(WEBM_RECORDER_MIMES);
  if (webmMime) {
    options.onProgress({ stage: 'record', ratio: 0, detail: 'Starting real-time capture' });
    const intermediate = await recordRealtime(options, webmMime);
    throwIfAborted(options.signal);
    options.onProgress({
      stage: 'convert',
      ratio: 0,
      detail: 'Converting to H.264 — this browser has no MP4 encoder, so it takes a while',
    });
    const { transcodeToMp4 } = await import('./transcode');
    const blob = await transcodeToMp4(intermediate, (ratio) =>
      options.onProgress({ stage: 'convert', ratio, detail: 'Converting to H.264 / AAC' }),
    );
    return { blob, mimeType: 'video/mp4', pipeline: 'ffmpeg', elapsedMs: now() - startedAt };
  }

  throw new Error(
    webCodecsError instanceof Error
      ? `Video export is not supported in this browser (${webCodecsError.message}). Try Chrome, Edge or Safari.`
      : 'Video export is not supported in this browser. Try Chrome, Edge or Safari.',
  );
}
