/** Microphone capture, file decoding, and the small helpers around both. */

/**
 * Anything longer than this is refused up front rather than failing mid-export.
 * Three minutes of 1080x1920 video is already ~110 MB held in memory while the MP4
 * is assembled, which is about as much as a phone browser will tolerate.
 */
export const MAX_DURATION_SECONDS = 180;
/** Above this the export gets slow enough to warrant a warning. */
export const LONG_DURATION_SECONDS = 90;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** MediaRecorder audio containers, most preferred first. */
const MIC_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/mpeg',
];

export function micRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

function pickMicMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const mime of MIC_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  // Let the browser choose its own default.
  return undefined;
}

let sharedContext: AudioContext | null = null;

/**
 * A single AudioContext pinned to 48 kHz. Decoding through it resamples every input
 * to one rate, which keeps the AAC encoder configuration predictable.
 */
function getAudioContext(): AudioContext {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('This browser has no Web Audio support.');
  try {
    sharedContext = new Ctor({ sampleRate: 48_000 });
  } catch {
    sharedContext = new Ctor();
  }
  return sharedContext;
}

/** Decode any browser-supported audio container into raw samples. */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const context = getAudioContext();
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer) => {
      if (!settled) {
        settled = true;
        resolve(buffer);
      }
    };
    const fail = (error: DOMException | Error | null) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            error?.message ||
              'That audio file could not be read. Try an MP3, M4A, WAV, OGG or WebM file.',
          ),
        );
      }
    };
    // Older Safari only supports the callback form, newer engines return a promise.
    const maybePromise = context.decodeAudioData(arrayBuffer, ok, fail);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(ok, fail);
    }
  });
}

export interface MicRecorderHandlers {
  /** Input level 0..1, sampled roughly every animation frame. */
  onLevel?: (level: number) => void;
  onElapsed?: (seconds: number) => void;
  onError?: (error: Error) => void;
}

/**
 * Thin wrapper around getUserMedia + MediaRecorder that also exposes a live input
 * level so the record button can show that the mic is actually picking something up.
 */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafHandle = 0;
  private startedAt = 0;

  constructor(private handlers: MicRecorderHandlers = {}) {}

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (!micRecordingSupported()) {
      throw new Error('Microphone recording is not available in this browser.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const mimeType = pickMicMime();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () =>
      this.handlers.onError?.(new Error('Recording stopped unexpectedly.'));

    // Level metering.
    this.context = getAudioContext();
    await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    source.connect(this.analyser);

    this.startedAt = performance.now();
    this.recorder.start(250);
    this.tick();
  }

  private tick = (): void => {
    if (!this.analyser || !this.recording) return;
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / samples.length);
    this.handlers.onLevel?.(Math.min(1, Math.pow(rms * 3.2, 0.7)));
    this.handlers.onElapsed?.((performance.now() - this.startedAt) / 1000);
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  /** Stop and resolve with the recorded audio. */
  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('Nothing is being recorded.');

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
    });

    this.teardown();
    return blob;
  }

  /** Abandon the recording and release the microphone. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.chunks = [];
    this.teardown();
  }

  private teardown(): void {
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.analyser = null;
    this.handlers.onLevel?.(0);
  }
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Turn a permission failure into something worth reading. */
export function describeMicError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow it in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy in another app. Close it and try again.';
    default:
      return (error as Error)?.message || 'The microphone could not be started.';
  }
}
