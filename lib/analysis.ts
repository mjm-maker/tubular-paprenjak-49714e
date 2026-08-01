/**
 * Offline audio analysis.
 *
 * Everything the animations need is precomputed once, straight off the decoded
 * `AudioBuffer`, instead of being sampled live from an `AnalyserNode`. That matters
 * because the exported video is encoded frame-by-frame (faster than real time), so
 * there is no playing audio graph to read from. Precomputing also guarantees the
 * preview and the exported MP4 show byte-identical motion.
 */

/** Frames per second of the exported video. */
export const FPS = 30;
/** Number of frequency bands driving the bar animation. */
export const BAND_COUNT = 40;
/** Amplitude-envelope resolution, in samples per second. */
export const ENV_RATE = 240;
/** Half-width of the waveform window, in envelope samples (~1.1s each side). */
export const WAVE_HALF = 264;

const FFT_SIZE = 1024;
const MIN_HZ = 45;
const MAX_HZ = 11_000;

export interface AudioAnalysis {
  /** Duration in seconds. */
  duration: number;
  frameCount: number;
  fps: number;
  envRate: number;
  /** Peak amplitude 0..1 per `1 / ENV_RATE` second. Drives the waveform. */
  env: Float32Array;
  /** Overall loudness 0..1 per video frame. */
  level: Float32Array;
  /** `BAND_COUNT` magnitudes 0..1 per video frame, laid out frame-major. */
  bands: Float32Array;
}

export interface FrameData {
  /** Loudness 0..1 for this frame. */
  level: number;
  /** `BAND_COUNT` magnitudes 0..1. */
  bands: Float32Array;
  /** `WAVE_HALF * 2 + 1` amplitudes 0..1, centred on the playhead. */
  wave: Float32Array;
  /** 0..1 through the clip. */
  progress: number;
  elapsed: number;
  duration: number;
}

/** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const br = re[b] * cr - im[b] * ci;
        const bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
}

/** Average the channels down to a single Float32Array. */
function toMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(length);

  if (channels === 1) {
    mono.set(buffer.getChannelData(0));
    return mono;
  }

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  const scale = 1 / channels;
  for (let i = 0; i < length; i++) mono[i] *= scale;
  return mono;
}

/** Log-spaced FFT bin ranges, one per band. */
function bandRanges(sampleRate: number): Array<[number, number]> {
  const nyquist = sampleRate / 2;
  const top = Math.min(MAX_HZ, nyquist * 0.92);
  const binHz = sampleRate / FFT_SIZE;
  const ranges: Array<[number, number]> = [];

  for (let b = 0; b < BAND_COUNT; b++) {
    const lowHz = MIN_HZ * Math.pow(top / MIN_HZ, b / BAND_COUNT);
    const highHz = MIN_HZ * Math.pow(top / MIN_HZ, (b + 1) / BAND_COUNT);
    const lowBin = Math.max(1, Math.floor(lowHz / binHz));
    const highBin = Math.max(lowBin + 1, Math.min(FFT_SIZE / 2 - 1, Math.ceil(highHz / binHz)));
    ranges.push([lowBin, highBin]);
  }
  return ranges;
}

/**
 * Peak amplitude per `1 / envRate` second, normalised to the loudest moment.
 *
 * One definition, used by the waveform animation, by the slice planner in
 * `lib/transcribe.ts` and by the subtitle aligner in `lib/align.ts` — so "where the
 * speech actually is" means the same thing everywhere it is asked.
 */
function envelopeFrom(mono: Float32Array, sampleRate: number, envRate: number): Float32Array {
  const seconds = mono.length / sampleRate;
  const envLength = Math.max(1, Math.ceil(seconds * envRate));
  const env = new Float32Array(envLength);
  const samplesPerEnv = sampleRate / envRate;
  let envPeak = 0;

  for (let e = 0; e < envLength; e++) {
    const start = Math.floor(e * samplesPerEnv);
    const end = Math.min(mono.length, Math.floor((e + 1) * samplesPerEnv));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const abs = Math.abs(mono[i]);
      if (abs > peak) peak = abs;
    }
    env[e] = peak;
    if (peak > envPeak) envPeak = peak;
  }

  const envScale = envPeak > 1e-5 ? 1 / envPeak : 0;
  for (let e = 0; e < envLength; e++) {
    // Slight perceptual lift so quiet speech still shows movement.
    env[e] = Math.pow(Math.min(1, env[e] * envScale), 0.8);
  }
  return env;
}

/** The same envelope `analyseAudio` builds, for callers that only need that. */
export function computeEnvelope(buffer: AudioBuffer, envRate: number = ENV_RATE): Float32Array {
  return envelopeFrom(toMono(buffer), buffer.sampleRate, envRate);
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Analyse a decoded buffer. Yields to the event loop periodically so the UI can
 * keep painting progress on long clips.
 */
export async function analyseAudio(
  buffer: AudioBuffer,
  onProgress?: (ratio: number) => void,
): Promise<AudioAnalysis> {
  const { sampleRate, duration } = buffer;
  const mono = toMono(buffer);
  const frameCount = Math.max(1, Math.ceil(duration * FPS));

  // --- Amplitude envelope -------------------------------------------------
  const env = envelopeFrom(mono, sampleRate, ENV_RATE);

  // --- Spectrum + loudness per video frame --------------------------------
  const ranges = bandRanges(sampleRate);
  const bands = new Float32Array(frameCount * BAND_COUNT);
  const level = new Float32Array(frameCount);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    // Hann window.
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const magnitudes = new Float32Array(FFT_SIZE / 2);

  let bandPeak = 0;
  let levelPeak = 0;

  for (let f = 0; f < frameCount; f++) {
    const centre = Math.floor((f / FPS) * sampleRate);
    const start = centre - FFT_SIZE / 2;

    let sumSquares = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const index = start + i;
      const sample = index >= 0 && index < mono.length ? mono[index] : 0;
      sumSquares += sample * sample;
      re[i] = sample * window[i];
      im[i] = 0;
    }

    const rms = Math.sqrt(sumSquares / FFT_SIZE);
    level[f] = rms;
    if (rms > levelPeak) levelPeak = rms;

    fft(re, im);
    for (let k = 0; k < magnitudes.length; k++) {
      magnitudes[k] = Math.hypot(re[k], im[k]);
    }

    const offset = f * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const [lowBin, highBin] = ranges[b];
      let sum = 0;
      for (let k = lowBin; k < highBin; k++) sum += magnitudes[k];
      // Tilt the high end up — speech energy is heavily bass-weighted and
      // untilted bars look like a wall on the left and nothing on the right.
      const value = (sum / (highBin - lowBin)) * (1 + b / (BAND_COUNT * 0.6));
      bands[offset + b] = value;
      if (value > bandPeak) bandPeak = value;
    }

    if (f % 240 === 0) {
      onProgress?.(f / frameCount);
      await yieldToUi();
    }
  }

  // --- Normalise + temporal smoothing -------------------------------------
  const bandScale = bandPeak > 1e-6 ? 1 / bandPeak : 0;
  const levelScale = levelPeak > 1e-6 ? 1 / levelPeak : 0;

  for (let f = 0; f < frameCount; f++) {
    level[f] = Math.pow(Math.min(1, level[f] * levelScale), 0.7);
    const offset = f * BAND_COUNT;
    const prevOffset = offset - BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const value = Math.pow(Math.min(1, bands[offset + b] * bandScale), 0.55);
      // Fast attack, slow release: bars snap up on a syllable and glide back.
      const decayed = f > 0 ? bands[prevOffset + b] * 0.82 : 0;
      bands[offset + b] = Math.max(value, decayed);
    }
  }

  onProgress?.(1);
  return { duration, frameCount, fps: FPS, envRate: ENV_RATE, env, level, bands };
}

const EMPTY_WAVE = new Float32Array(WAVE_HALF * 2 + 1);

/** Slice out everything the renderer needs to draw one frame. */
export function getFrameData(analysis: AudioAnalysis, frameIndex: number): FrameData {
  const frame = Math.min(analysis.frameCount - 1, Math.max(0, frameIndex));
  const elapsed = frame / analysis.fps;

  const wave = new Float32Array(EMPTY_WAVE.length);
  const centre = Math.round(elapsed * analysis.envRate);
  for (let i = 0; i < wave.length; i++) {
    const index = centre - WAVE_HALF + i;
    wave[i] = index >= 0 && index < analysis.env.length ? analysis.env[index] : 0;
  }

  return {
    level: analysis.level[frame] ?? 0,
    bands: analysis.bands.subarray(frame * BAND_COUNT, frame * BAND_COUNT + BAND_COUNT),
    wave,
    progress: analysis.frameCount > 1 ? frame / (analysis.frameCount - 1) : 1,
    elapsed,
    duration: analysis.duration,
  };
}

/**
 * A short synthetic analysis used to animate the preview before any audio has
 * been supplied, so the waveform/bars choice is visible up front.
 */
export function createDemoAnalysis(): AudioAnalysis {
  const duration = 4;
  const frameCount = duration * FPS;
  const envLength = duration * ENV_RATE;
  const env = new Float32Array(envLength);
  const level = new Float32Array(frameCount);
  const bands = new Float32Array(frameCount * BAND_COUNT);

  for (let e = 0; e < envLength; e++) {
    const t = e / ENV_RATE;
    const syllable = Math.max(0, Math.sin(t * 5.1) * 0.6 + Math.sin(t * 11.3) * 0.28 + 0.34);
    env[e] = Math.min(1, syllable * (0.55 + 0.45 * Math.abs(Math.sin(t * 1.7))));
  }

  for (let f = 0; f < frameCount; f++) {
    const t = f / FPS;
    const pulse = 0.45 + 0.4 * Math.abs(Math.sin(t * 3.4));
    level[f] = pulse;
    const offset = f * BAND_COUNT;
    for (let b = 0; b < BAND_COUNT; b++) {
      const tilt = 1 - b / (BAND_COUNT * 1.6);
      const wobble = Math.sin(t * 6.2 + b * 0.42) * 0.4 + Math.sin(t * 2.3 - b * 0.19) * 0.3;
      bands[offset + b] = Math.max(0.04, Math.min(1, tilt * pulse * (0.7 + wobble)));
    }
  }

  return { duration, frameCount, fps: FPS, envRate: ENV_RATE, env, level, bands };
}
