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
import { DEFAULT_FORMAT, layoutFor } from './layout';
import { drawFrame, type RenderSpec } from './render';

export type Pipeline = 'webcodecs' | 'mediarecorder' | 'ffmpeg';

export type EncodeStage = 'render' | 'record' | 'convert' | 'package' | 'verify';

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
  /** Frame size actually encoded. */
  width: number;
  height: number;
  /** What the audibility check found in the finished file. */
  audio: AudioProof;
}

export interface EncodeOptions {
  audioBuffer: AudioBuffer;
  analysis: AudioAnalysis;
  spec: RenderSpec;
  onProgress: (progress: EncodeProgress) => void;
  signal?: AbortSignal;
  /**
   * An AudioContext already started inside the user gesture that began the export.
   *
   * Only the real-time pipelines need one, and by the time they run the gesture is long
   * gone — which on iOS Safari means a context created here would stay suspended and feed
   * the recorder pure silence. The page unlocks the shared context on the tap and passes
   * it down; a missing one is still handled, it is just the case that fails on a phone.
   */
  audioContext?: AudioContext | null;
}

const AUDIO_BITRATE = 128_000;

/**
 * Lead-in the realtime pipelines schedule the voice with, in seconds.
 *
 * Small, but the point is that it is *scheduled*: the paint loop draws against the
 * instant the voice was told to begin, so the frames and the sound share one clock.
 * Starting the source "now" instead leaves the two a JavaScript task apart, and every
 * frame — the subtitles included — sits that far ahead of the words.
 */
const AUDIO_START_LEAD = 0.06;

/**
 * Channels written into every export.
 *
 * Fixed at two rather than copied from the input. A mono AAC track is one of the
 * ways a video arrives on Facebook or Instagram with its sound gone: their
 * transcoders are far less tolerant than a browser, and a mono track at an
 * unexpected rate is where the silence comes from. `lib/mix.ts` already renders a
 * stereo buffer; a mono one reaching here is duplicated across both channels
 * rather than narrowing the file.
 */
const EXPORT_CHANNELS = 2;


/**
 * How much of the clip the muxed audio has to cover before the file is accepted.
 * A track that stops a fraction of a second early is the encoder's tail; a track that
 * stops halfway is a bug, and shipping it means a video that goes quiet mid-sentence.
 */
const MIN_AUDIO_COVERAGE = 0.9;

/** Codec signatures the muxers write into the file header for an audio track. */
const MP4_AUDIO_SIGNATURES = ['mp4a', 'Opus'];
const WEBM_AUDIO_SIGNATURES = ['A_OPUS', 'A_VORBIS', 'A_AAC'];

/** Bytes inspected at each end of the file when looking for that signature. */
const SIGNATURE_SCAN_BYTES = 8 * 1024 * 1024;

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

/**
 * A sample of every glyph the frame is about to set, so the font loader has something
 * concrete to fetch. Real cue text is included because a webfont is subsetted: the
 * Cyrillic half of Inter is a separate file, and asking for it in the abstract does not
 * bring it down.
 */
function textSample(spec: RenderSpec): string {
  let sample = 'AaBbCcXxYyZz АаБбВвГгДдЕеЖжЗзИиЙйКкЛлМмНнОоПпРрСсТтУуФфХхЦцЧчШшЩщЪъЬьЮюЯя 0123456789';
  for (const cue of spec.subtitles?.cues.slice(0, 24) ?? []) {
    sample += ` ${cue.bg} ${cue.en}`;
  }
  return sample.slice(0, 1200);
}

/**
 * Make sure the faces the frame paints in are really loaded before the first frame.
 *
 * `document.fonts.ready` on its own is not enough, and this is the difference between
 * subtitles that are in the preview and subtitles that are in the file. That promise
 * settles for the faces the page has already *asked* for, and a subsetted webfont is only
 * requested once a glyph from it is laid out somewhere. A Bulgarian cue can easily be the
 * first Cyrillic text the tab has ever needed, so the fetch starts as the export is
 * drawing — too late for the frames already encoded, and on an engine that measures a
 * pending face as zero-width, too late for all of them.
 *
 * Asking for the exact `weight px family` combinations against the actual cue text forces
 * the fetch to happen first. Every step is optional: a face that will not load leaves a
 * fallback family, which is worse-looking and still legible.
 */
async function ensureFontsReady(spec: RenderSpec): Promise<void> {
  try {
    const faces = typeof document !== 'undefined' ? document.fonts : null;
    if (!faces) return;
    const sample = textSample(spec);
    const pending: Array<Promise<unknown>> = [];
    const ask = (weight: number, family: string, text: string) => {
      try {
        pending.push(Promise.resolve(faces.load(`${weight} 64px ${family}`, text)));
      } catch {
        // An unparseable stack is not worth failing an export over.
      }
    };
    // Subtitles, the watermark and anything else that can contain Cyrillic are set in
    // `sans`, across every weight the five subtitle styles use.
    for (const weight of [400, 500, 600, 700, 800]) ask(weight, spec.fonts.sans, sample);
    ask(400, spec.fonts.display, sample);
    ask(400, spec.fonts.mono, '0123456789:-');
    await Promise.all(pending.map((promise) => promise.catch(() => undefined)));
    await faces.ready;
  } catch {
    // Font loading is a nicety; a fallback family still renders.
  }
}

// --- audio verification ---------------------------------------------------

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Does the finished file actually carry an audio track?
 *
 * Every pipeline here believes it muxed the voice in, and a silent export is exactly
 * the case where that belief is wrong — so the last word goes to the bytes rather than
 * to the encoder that produced them. Each container names its audio codec in the
 * header (`mp4a` in the MP4 sample description, `A_OPUS` in the WebM track entry), so
 * finding that string is enough to know a track was written at all.
 *
 * Both ends are scanned because MediaRecorder may put its metadata at either one, and
 * an unreadable file is treated as fine: this check exists to catch a missing track,
 * not to become a new way for the export to fail.
 */
async function hasAudioTrack(blob: Blob, mimeType: string): Promise<boolean> {
  const signatures = mimeType.includes('webm') ? WEBM_AUDIO_SIGNATURES : MP4_AUDIO_SIGNATURES;
  try {
    const head = new Uint8Array(
      await blob.slice(0, Math.min(blob.size, SIGNATURE_SCAN_BYTES)).arrayBuffer(),
    );
    if (signatures.some((signature) => indexOfAscii(head, signature) !== -1)) return true;
    if (blob.size <= SIGNATURE_SCAN_BYTES) return false;
    const tail = new Uint8Array(
      await blob.slice(Math.max(0, blob.size - SIGNATURE_SCAN_BYTES)).arrayBuffer(),
    );
    return signatures.some((signature) => indexOfAscii(tail, signature) !== -1);
  } catch {
    return true;
  }
}

/** How the finished file's audio was checked, and what was found. */
export interface AudioProof {
  audible: boolean;
  /**
   * `decoded` — the file's own audio track was decoded back to samples and measured.
   * `captured` — the decode was unavailable, so the track was measured live off the
   *   very MediaStream the recorder was writing.
   * `container` — only the container's audio-track signature could be checked.
   * `too-large` — decoding would have needed more memory than it is worth.
   * `undecodable` — this browser cannot decode what it just wrote.
   */
  method: 'decoded' | 'captured' | 'container' | 'too-large' | 'undecodable';
  /** Loudest sample found, 0..1. Zero when the method was not `decoded`. */
  peak: number;
  rms: number;
  /** Seconds of audio the decoder found. */
  seconds: number;
}

/**
 * Anything quieter than this in both peak and RMS is silence, not quiet speech.
 * A 16-bit sample floor is ~0.00003, so these sit far above rounding noise and far
 * below anything a listener would call audible.
 */
const AUDIBLE_PEAK = 0.005;
const AUDIBLE_RMS = 0.0004;

/**
 * Above this the decode is skipped: `decodeAudioData` expands the whole track to
 * 32-bit PCM, which for a three-minute stereo clip is tens of megabytes on top of a
 * copy of the file itself. The container check still runs, so a long export is
 * verified less deeply rather than not at all.
 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/** Peak and RMS of a buffer, measured across every channel. */
function measureBuffer(buffer: AudioBuffer): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  let counted = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    // Every 7th sample: 7 is coprime with any power-of-two block size, so the walk
    // cannot land on the same phase of a periodic signal and read it as silence.
    for (let i = 0; i < data.length; i += 7) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
      sumSquares += data[i] * data[i];
      counted++;
    }
  }
  return { peak, rms: counted > 0 ? Math.sqrt(sumSquares / counted) : 0 };
}

/**
 * Decode the finished MP4's own audio track and confirm there is sound in it.
 *
 * The pipelines already prove that an audio track was written, that its packets
 * carry a decoder description, and that they reach the end of the clip. None of
 * that proves the samples are not all zeroes — which is what a muted microphone, a
 * suspended audio context or a header/sample mismatch actually produces. So the
 * last check listens: hand the exported bytes back to the browser as if it were a
 * downloaded file, decode them, and measure.
 *
 * Fails open. A browser that cannot decode its own AAC output (Firefox, depending on
 * the platform's codecs) reports `undecodable` and the export still succeeds on the
 * strength of the container checks — refusing to export because the *verifier* is
 * unsupported would be a worse bug than the one it is looking for.
 */
export async function verifyExportedAudio(
  blob: Blob,
  mimeType: string,
  expectedSeconds: number,
  sharedContext?: AudioContext | null,
): Promise<AudioProof> {
  const container = await hasAudioTrack(blob, mimeType);
  if (!container) {
    return { audible: false, method: 'container', peak: 0, rms: 0, seconds: 0 };
  }
  if (blob.size > MAX_DECODE_BYTES) {
    return { audible: true, method: 'too-large', peak: 0, rms: 0, seconds: 0 };
  }

  type AudioCtor = typeof AudioContext;
  const Ctor: AudioCtor | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  // The page's own context is reused when it was handed down, because iOS caps how many
  // may be alive at once and the export has already opened one to play the voice.
  const context = sharedContext ?? (Ctor ? new Ctor() : null);
  if (!context) return { audible: true, method: 'undecodable', peak: 0, rms: 0, seconds: 0 };

  try {
    const bytes = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(bytes);
    const { peak, rms } = measureBuffer(decoded);
    const longEnough = decoded.duration >= expectedSeconds * MIN_AUDIO_COVERAGE;
    return {
      audible: peak >= AUDIBLE_PEAK && rms >= AUDIBLE_RMS && longEnough,
      method: 'decoded',
      peak,
      rms,
      seconds: decoded.duration,
    };
  } catch {
    return { audible: true, method: 'undecodable', peak: 0, rms: 0, seconds: 0 };
  } finally {
    if (context !== sharedContext) void context.close().catch(() => {});
  }
}

/** Human-readable summary of the proof, shown next to the finished file. */
export function describeAudioProof(proof: AudioProof): string {
  switch (proof.method) {
    case 'decoded':
      return `Audio verified — decoded ${proof.seconds.toFixed(1)}s, peak ${proof.peak.toFixed(2)}`;
    case 'captured':
      return `Audio verified — the recorded track carried sound, peak ${proof.peak.toFixed(2)}`;
    case 'too-large':
      return 'Audio track confirmed in the container (file too large to decode here)';
    case 'undecodable':
      return 'Audio track confirmed in the container (this browser cannot decode MP4 audio)';
    case 'container':
      return 'No audio track found in the container';
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

/** The frame size this spec's format asks for. */
function frameSize(spec: RenderSpec): { width: number; height: number } {
  const layout = layoutFor(spec.format ?? DEFAULT_FORMAT);
  return { width: layout.width, height: layout.height };
}

async function pickVideoConfig(
  bitrate: number,
  width: number,
  height: number,
): Promise<VideoEncoderConfig | null> {
  for (const codec of H264_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
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
    // Deliberately our own object rather than `support.config`: the encoder, the
    // AudioData chunks fed to it and the muxer's audio track header all have to state
    // the same sample rate and channel count. A browser that hands back a normalised
    // echo would split them apart, and a track whose header disagrees with its own
    // samples is a track players decode as silence.
    if (support.supported) return config;
  } catch {
    // Fall through.
  }
  return null;
}

async function encodeWithWebCodecs(options: EncodeOptions): Promise<Blob | null> {
  const { audioBuffer, analysis, spec, onProgress, signal } = options;
  if (!webCodecsAvailable()) return null;

  const { width, height } = frameSize(spec);
  const channels = EXPORT_CHANNELS;
  // A mono buffer is duplicated rather than narrowing the file to one channel.
  const readChannel = (index: number) =>
    audioBuffer.getChannelData(Math.min(index, audioBuffer.numberOfChannels - 1));

  const [videoConfig, audioConfig] = await Promise.all([
    pickVideoConfig(videoBitrateFor(analysis.duration), width, height),
    pickAudioConfig(audioBuffer.sampleRate, channels),
  ]);
  if (!videoConfig || !audioConfig) return null;

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    // An AAC encoder is allowed to stamp its first packet with the priming delay
    // instead of zero, which the muxer's strict mode rejects outright — and losing the
    // mux loses the only pipeline that reliably carries sound. Offsetting each track by
    // its own first timestamp both keeps the file and removes the leading gap.
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width, height, frameRate: FPS },
    audio: {
      codec: 'aac',
      // Exactly what the AudioData chunks below carry, so the track header can never
      // describe something other than the samples inside it.
      numberOfChannels: channels,
      sampleRate: audioBuffer.sampleRate,
    },
  });

  let failure: Error | null = null;
  // The audio track is the thing most easily lost on the way into the container, so it
  // is accounted for rather than assumed: how many packets arrived, whether the decoder
  // description that makes them playable came with them, and how far they reach.
  //
  // The description matters more than it looks. The muxer writes the AAC `esds`
  // descriptor straight from it, and given nothing it writes an empty one without
  // complaint — a file that carries every audio packet, plays back, and is silent.
  let audioChunkCount = 0;
  let audioDescribed = false;
  let audioEndMicroseconds = 0;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      audioChunkCount++;
      if ((meta?.decoderConfig?.description?.byteLength ?? 0) > 0) audioDescribed = true;
      audioEndMicroseconds = Math.max(
        audioEndMicroseconds,
        chunk.timestamp + (chunk.duration ?? 0),
      );
      muxer.addAudioChunk(chunk, meta);
    },
    error: (error) => {
      failure = error;
    },
  });

  // A DOM canvas, deliberately, even where OffscreenCanvas exists. The preview draws into
  // one, and the rendering contract is that both draw the *same* frame — which only holds
  // if `ctx.font` resolves the page's webfonts the same way in both. Safari does not give
  // an OffscreenCanvas the document's font set, so a subtitle set in Inter measures and
  // paints there as something else, or as nothing: on screen and not in the file. The
  // speed of this path is bounded by the encoder, not by the canvas.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
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
        view.set(readChannel(c).subarray(offset, offset + frames), c * frames);
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

      // One clock for the three things that have to agree. `frame.elapsed` is the instant
      // the animation is read at and the instant `cueAt` picks the subtitle for, so it is
      // also the instant the frame is stamped with — rather than a second expression that
      // happens to evaluate to the same number today. The audio above is timestamped from
      // its own sample offset against the same zero, which is where they meet.
      const frame = getFrameData(analysis, index);
      drawFrame(ctx, frame, spec, index, 1);
      const videoFrame = new VideoFrame(canvas, {
        timestamp: Math.round(frame.elapsed * 1_000_000),
        duration: Math.round(microsecondsPerFrame),
      });
      // A keyframe every two seconds keeps seeking snappy in social feeds.
      videoEncoder.encode(videoFrame, { keyFrame: index % (FPS * 2) === 0 });
      videoFrame.close();

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

    // Refuse to finish a video whose sound went missing, so the orchestrator falls
    // through to a pipeline that does carry it instead of handing back a silent file.
    if (audioChunkCount === 0) {
      throw new Error('the AAC encoder produced no audio packets');
    }
    if (!audioDescribed) {
      throw new Error('the AAC encoder gave no decoder description, so the track would be silent');
    }
    const audioSeconds = audioEndMicroseconds / 1_000_000;
    if (audioSeconds < audioBuffer.duration * MIN_AUDIO_COVERAGE) {
      throw new Error(
        `the audio track covered only ${audioSeconds.toFixed(1)}s of ${audioBuffer.duration.toFixed(1)}s`,
      );
    }

    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    if (!(await hasAudioTrack(blob, 'video/mp4'))) {
      throw new Error('the finished MP4 had no audio track');
    }
    return blob;
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

/** What a real-time capture produced, and what its audio track was heard to carry. */
interface RealtimeCapture {
  blob: Blob;
  /**
   * Peak amplitude read off the very MediaStream track the recorder was writing, or
   * `null` where the engine would not let us listen to it.
   */
  trackPeak: number | null;
}

/**
 * Play the audio through a MediaStream while a canvas is painted in real time, and
 * record both into one file.
 */
async function recordRealtime(options: EncodeOptions, mimeType: string): Promise<RealtimeCapture> {
  const { audioBuffer, analysis, spec, onProgress, signal } = options;

  const { width, height } = frameSize(spec);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('This browser cannot draw to a canvas.');

  // Paint frame zero so the stream never starts on a blank canvas.
  drawFrame(ctx, getFrameData(analysis, 0), spec, 0, 1);

  // The context the page unlocked on the tap, where there is one. Building a fresh one
  // here is what fails on iOS: the gesture that would have been allowed to start it was
  // spent several awaits ago, so it stays suspended and the recording comes out silent.
  const provided = options.audioContext ?? null;
  const audioContext = provided ?? new AudioContext({ sampleRate: audioBuffer.sampleRate });
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  const destination = audioContext.createMediaStreamDestination();
  // Two channels for the same reason the WebCodecs path forces them: a mono track is
  // what several platforms re-encode into silence.
  try {
    destination.channelCount = EXPORT_CHANNELS;
    destination.channelCountMode = 'explicit';
  } catch {
    // Some engines pin this node's channel count; the recorder still gets audio.
  }
  source.connect(destination);

  const stream = canvas.captureStream(FPS);
  // The recorder captures whatever tracks the stream holds when it starts, so a missing
  // audio track here is a silent MP4 later. Checked rather than hoped for: some engines
  // hand back a destination with no track at all if the graph never started.
  const voiceTracks = destination.stream.getAudioTracks();
  for (const track of voiceTracks) stream.addTrack(track);
  if (stream.getAudioTracks().length === 0) {
    for (const track of [...stream.getTracks(), ...voiceTracks]) track.stop();
    if (!provided) void audioContext.close();
    throw new Error(
      'This browser would not put the voice track into the recording, so the video would have no sound.',
    );
  }

  // Listen to the track that is going into the file, while it goes in.
  //
  // This is the answer to the one failure this whole module is built around. Safari will
  // accept a Web Audio track into a canvas capture stream, record it, and write silence —
  // and its own fragmented MP4 then very often cannot be handed back to `decodeAudioData`,
  // so the check that would have caught it fails open and the silent file is offered as a
  // success. A tap on the track itself needs no decoder and no container support: if this
  // never sees a sample above the silence floor, nothing in the file will be audible.
  let trackPeak: number | null = null;
  let analyser: AnalyserNode | null = null;
  let probe: Float32Array<ArrayBuffer> | null = null;
  try {
    const probeSource = audioContext.createMediaStreamSource(new MediaStream(voiceTracks));
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    probeSource.connect(analyser);
    probe = new Float32Array(analyser.fftSize);
    trackPeak = 0;
  } catch {
    // No probe on this engine: the decode check downstream stays the only word.
    analyser = null;
    probe = null;
    trackPeak = null;
  }

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
    // Only ours to close. The page's shared context outlives the export and is what the
    // next one will need to still be running.
    if (!provided) void audioContext.close();
  };

  const onAbort = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  signal?.addEventListener('abort', onAbort);

  try {
    await audioContext.resume();
    // A suspended context feeds the recorder a track of pure silence, which records
    // perfectly and plays back as nothing at all.
    if (audioContext.state !== 'running') {
      throw new Error('The audio engine would not start, so the video would have no sound.');
    }
    recorder.start(1000);
    const startedAt = audioContext.currentTime + AUDIO_START_LEAD;
    source.start(startedAt);
    let lastReport = -1;

    const paint = () => {
      if (finished) return;
      // Clamped, so the lead-in holds on the first frame instead of running the clip
      // backwards — the voice has not started yet, and neither has the video.
      const elapsed = Math.max(0, audioContext.currentTime - startedAt);
      const index = Math.min(analysis.frameCount - 1, Math.max(0, Math.round(elapsed * FPS)));
      drawFrame(ctx, getFrameData(analysis, index), spec, index, 1);
      if (analyser && probe) {
        analyser.getFloatTimeDomainData(probe);
        for (let i = 0; i < probe.length; i += 4) {
          const value = Math.abs(probe[i]);
          if (value > (trackPeak ?? 0)) trackPeak = value;
        }
      }
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
    return { blob: new Blob(chunks, { type: recorder.mimeType || mimeType }), trackPeak };
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

  // Nothing downstream can put back audio that was never handed over, and a video with
  // no voice in it is not worth the wait it costs to build.
  if (!options.audioBuffer || options.audioBuffer.length === 0) {
    throw new Error(
      'There is no audio to put in the video. Record or upload a voice message first.',
    );
  }
  // The cheapest of the three audio checks, and the only one that behaves identically in
  // every browser: an encoder can lose sound but never invent it, so if what goes in is
  // silence, every route out is silence too. Said now rather than after a minute of a
  // phone's battery has gone into proving it.
  if (measureBuffer(options.audioBuffer).peak < AUDIBLE_PEAK) {
    throw new Error(
      'The recording is silent, so the video would be too. Check the microphone and the voice volume, then record again.',
    );
  }

  // Before any frame is painted, and before the preview's own font resolution is trusted:
  // a subtitle in a face that has not arrived yet is a subtitle that is not in the file.
  await ensureFontsReady(options.spec);
  const { width, height } = frameSize(options.spec);
  const expectedSeconds = options.audioBuffer.duration;

  /** Listen to a finished file before accepting it. */
  const proveAudio = async (blob: Blob, mimeType: string): Promise<AudioProof> => {
    options.onProgress({
      stage: 'verify',
      ratio: 0.5,
      detail: 'Checking the exported file has audible sound',
    });
    return verifyExportedAudio(blob, mimeType, expectedSeconds, options.audioContext);
  };

  /**
   * Reconcile the two ways a real-time capture can be checked.
   *
   * Decoding the finished file is the better evidence and wins whenever it is available.
   * Where it is not — which on iPhone Safari is the common case, since it frequently
   * cannot read back the fragmented MP4 it just wrote — the proof would otherwise fail
   * open and a silent file would be handed over as a success. The peak measured off the
   * recorded track answers the same question without needing a decoder.
   */
  const reconcile = (audio: AudioProof, trackPeak: number | null): AudioProof => {
    if (audio.method === 'decoded' || trackPeak === null) return audio;
    return {
      audible: trackPeak >= AUDIBLE_PEAK,
      method: 'captured',
      peak: trackPeak,
      rms: 0,
      seconds: expectedSeconds,
    };
  };

  // 1. WebCodecs. Verifies its own audio track before returning, so a failure here is
  //    a reason to try the next pipeline rather than something to hand to the user.
  options.onProgress({ stage: 'render', ratio: 0, detail: 'Preparing the encoder' });
  let webCodecsError: unknown = null;
  let recorderError: unknown = null;
  try {
    const blob = await encodeWithWebCodecs(options);
    if (blob && blob.size > 0) {
      const audio = await proveAudio(blob, 'video/mp4');
      if (audio.audible) {
        return {
          blob,
          mimeType: 'video/mp4',
          pipeline: 'webcodecs',
          elapsedMs: now() - startedAt,
          width,
          height,
          audio,
        };
      }
      throw new Error('the exported file decoded to silence');
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    webCodecsError = error;
  }

  // 2. MediaRecorder straight to MP4.
  const mp4Mime = pickRecorderMime(MP4_RECORDER_MIMES);
  if (mp4Mime) {
    options.onProgress({ stage: 'record', ratio: 0, detail: 'Starting real-time capture' });
    try {
      const { blob, trackPeak } = await recordRealtime(options, mp4Mime);
      const mimeType = blob.type || 'video/mp4';
      // A recorder that quietly wrote video only leaves the WebM route below as the one
      // remaining way to get a file with sound, so fall through instead of returning.
      if (blob.size > 0) {
        const audio = reconcile(await proveAudio(blob, mimeType), trackPeak);
        if (audio.audible) {
          return {
            blob,
            mimeType,
            pipeline: 'mediarecorder',
            elapsedMs: now() - startedAt,
            width,
            height,
            audio,
          };
        }
        recorderError = new Error('the real-time capture came out silent');
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      recorderError = error;
    }
    throwIfAborted(options.signal);
  }

  // 3. WebM capture, then convert.
  const webmMime = pickRecorderMime(WEBM_RECORDER_MIMES);
  if (webmMime) {
    options.onProgress({ stage: 'record', ratio: 0, detail: 'Starting real-time capture' });
    const { blob: intermediate, trackPeak } = await recordRealtime(options, webmMime);
    throwIfAborted(options.signal);
    // Checked before the transcode rather than after: ffmpeg would happily spend
    // minutes turning a soundless recording into a soundless MP4.
    if (!(await hasAudioTrack(intermediate, intermediate.type || webmMime))) {
      throw new Error(
        'This browser recorded the video without its audio track. Try Chrome, Edge or Safari.',
      );
    }
    if (trackPeak !== null && trackPeak < AUDIBLE_PEAK) {
      throw new Error(
        'This browser recorded the video without any sound in it. Try Chrome, Edge or Safari.',
      );
    }
    options.onProgress({
      stage: 'convert',
      ratio: 0,
      detail: 'Converting to H.264 — this browser has no MP4 encoder, so it takes a while',
    });
    const { transcodeToMp4 } = await import('./transcode');
    const blob = await transcodeToMp4(intermediate, (ratio) =>
      options.onProgress({ stage: 'convert', ratio, detail: 'Converting to H.264 / AAC' }),
    );
    const audio = reconcile(await proveAudio(blob, 'video/mp4'), trackPeak);
    if (!audio.audible) {
      throw new Error('The converted MP4 came out without audible audio. Please try again.');
    }
    return {
      blob,
      mimeType: 'video/mp4',
      pipeline: 'ffmpeg',
      elapsedMs: now() - startedAt,
      width,
      height,
      audio,
    };
  }

  // Nothing worked. Lead with whatever the pipelines actually complained about, since
  // "no audio track" is a very different problem from "no H.264 encoder".
  const reason = [webCodecsError, recorderError].find(
    (error): error is Error => error instanceof Error,
  );
  throw new Error(
    reason
      ? `Video export is not supported in this browser (${reason.message}). Try Chrome, Edge or Safari.`
      : 'Video export is not supported in this browser. Try Chrome, Edge or Safari.',
  );
}
