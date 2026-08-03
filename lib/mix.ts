/**
 * Mixes the background music into the voice recording.
 *
 * The mix is rendered offline into a single AudioBuffer *before* encoding, which
 * means `lib/encode.ts` never has to know that music exists — all three export
 * pipelines just receive one buffer, exactly as they did when there was only a
 * voice track.
 *
 * Loop and trim both fall out of the graph rather than needing sample maths: the
 * music source has `loop = true`, and the OfflineAudioContext is only as long as
 * the voice, so a short track repeats and a long one stops when the render ends.
 *
 * `musicGainAt` and `duckGainAt` are exported so the live preview can apply the
 * same curves to its `<audio>` element. Keeping one definition of each is what
 * stops the preview and the exported file from disagreeing.
 *
 * This module also decides the *shape* of the buffer the encoder receives —
 * stereo, at a sample rate the social platforms accept. See `PLATFORM_SAMPLE_RATE`.
 */

/** Short enough not to swallow the opening word, long enough not to click. */
export const MUSIC_FADE_SECONDS = 1.2;

/**
 * Channel count and sample rate of every buffer handed to the encoder.
 *
 * Facebook, Instagram and TikTok all re-encode what they are given, and their
 * transcoders are markedly less forgiving than a browser: a mono track, or one at
 * an unusual rate, is where "it had sound on my phone and went silent after
 * upload" comes from. Normalising here — rather than in the encoder — keeps a
 * single source of truth for the audio format, which is exactly what the muxer's
 * track header has to agree with.
 */
export const MIX_CHANNELS = 2;
export const PLATFORM_SAMPLE_RATE = 48_000;
/**
 * Exported so the encoder can refuse a rate it would have to describe wrongly.
 * `mp4-muxer` names the sample rate by index in the AAC decoder configuration, and a
 * rate that has no index there is written as a corrupt one — a track whose header and
 * whose own configuration disagree, which players decode as silence.
 */
export const ACCEPTED_SAMPLE_RATES: readonly number[] = [48_000, 44_100];

/** How far the music is pulled down while the voice is actually speaking. */
export const DUCK_DEPTH = 0.62;

/**
 * Hard ceiling on the music level, as a fraction of the voice level.
 *
 * The slider can ask for more than this; it does not get it. A music bed that can
 * be turned up until it covers the speaker is a way to ruin a recording in one
 * drag, and the whole point of the feature is the voice.
 */
export const MUSIC_HEADROOM = 0.6;

/** Envelope resolution for the duck, in samples per second. */
const DUCK_RATE = 40;
/** Voice level, as a fraction of the clip's own peak, that counts as full speech. */
const SPEECH_FLOOR = 0.22;

type OfflineCtor = typeof OfflineAudioContext;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Usable fade length: never more than half the clip, so in and out cannot overlap. */
function fadeFor(duration: number, fadeSeconds: number): number {
  return Math.max(0, Math.min(fadeSeconds, duration / 2));
}

/**
 * The music envelope at a given playback position: linear in, linear out, full
 * level in between.
 */
export function musicGainAt(
  elapsed: number,
  duration: number,
  fadeSeconds: number = MUSIC_FADE_SECONDS,
): number {
  if (duration <= 0) return 0;
  const fade = fadeFor(duration, fadeSeconds);
  if (fade <= 0) return 1;
  const rising = clamp01(elapsed / fade);
  const falling = clamp01((duration - elapsed) / fade);
  return Math.min(rising, falling);
}

/** The music level actually used, given both sliders. Never above the voice. */
export function effectiveMusicLevel(musicVolume: number, voiceVolume: number): number {
  return Math.min(clamp01(musicVolume), clamp01(voiceVolume) * MUSIC_HEADROOM);
}

/** True when the ceiling above is what is setting the level, not the slider. */
export function musicLevelCapped(musicVolume: number, voiceVolume: number): boolean {
  return clamp01(musicVolume) > clamp01(voiceVolume) * MUSIC_HEADROOM + 0.0005;
}

// --- voice-priority ducking ------------------------------------------------

export interface DuckEnvelope {
  /** Samples per second. */
  rate: number;
  /** Music gain multiplier 0..1, one per `1 / rate` second. */
  gain: Float32Array;
}

/**
 * Work out when the voice is speaking, and by how much to pull the music down.
 *
 * This is a sidechain compressor written out by hand. The Web Audio API has no
 * sidechain input, and the export is rendered offline where there is nothing to
 * listen to anyway, so the envelope is measured from the voice buffer up front and
 * played back into the music gain as automation. Fast attack so the bed is already
 * out of the way by the first syllable, slow release so it does not pump between
 * words.
 */
export function buildDuckEnvelope(voice: AudioBuffer, depth = DUCK_DEPTH): DuckEnvelope {
  const rate = DUCK_RATE;
  const windowSamples = Math.max(1, Math.round(voice.sampleRate / rate));
  const steps = Math.max(1, Math.ceil(voice.length / windowSamples));
  const loudness = new Float32Array(steps);

  const channels = Math.min(2, voice.numberOfChannels);
  let peak = 0;
  for (let step = 0; step < steps; step++) {
    const start = step * windowSamples;
    const end = Math.min(voice.length, start + windowSamples);
    let sumSquares = 0;
    let counted = 0;
    for (let c = 0; c < channels; c++) {
      const data = voice.getChannelData(c);
      for (let i = start; i < end; i++) {
        sumSquares += data[i] * data[i];
        counted++;
      }
    }
    const value = counted > 0 ? Math.sqrt(sumSquares / counted) : 0;
    loudness[step] = value;
    if (value > peak) peak = value;
  }

  const gain = new Float32Array(steps);
  if (peak <= 1e-5) {
    gain.fill(1);
    return { rate, gain };
  }

  // Attack and release as one-pole coefficients over the envelope's own step.
  const attack = 1 - Math.exp(-1 / (rate * 0.04));
  const release = 1 - Math.exp(-1 / (rate * 0.45));
  const threshold = peak * SPEECH_FLOOR;
  let presence = 0;
  for (let step = 0; step < steps; step++) {
    const target = clamp01((loudness[step] - threshold * 0.35) / Math.max(1e-6, threshold));
    presence += (target > presence ? attack : release) * (target - presence);
    gain[step] = 1 - clamp01(depth) * clamp01(presence);
  }
  return { rate, gain };
}

/** Read the duck envelope at a playback position. Returns 1 when there is none. */
export function duckGainAt(envelope: DuckEnvelope | null | undefined, elapsed: number): number {
  if (!envelope || envelope.gain.length === 0) return 1;
  const index = Math.round(elapsed * envelope.rate);
  if (index <= 0) return envelope.gain[0];
  if (index >= envelope.gain.length) return envelope.gain[envelope.gain.length - 1];
  return envelope.gain[index];
}

export interface MixRequest {
  voice: AudioBuffer;
  music: AudioBuffer | null;
  /** 0..1 */
  voiceVolume: number;
  /** 0..1 */
  musicVolume: number;
  fadeSeconds?: number;
  /**
   * Pre-computed duck envelope. Built here when omitted; the page passes the one
   * it already built for the preview so the two cannot drift apart.
   */
  duck?: DuckEnvelope | null;
}

/**
 * A soft limiter for the master bus.
 *
 * Voice at 100% plus music on top can exceed full scale on peaks, and hard
 * clipping in an exported file sounds like damage. The curve is dead linear below
 * 0.7 so ordinary levels pass through untouched, and compresses smoothly above it.
 */
function softLimiter(context: BaseAudioContext): WaveShaperNode {
  const shaper = context.createWaveShaper();
  const points = 2048;
  const curve = new Float32Array(points);
  const knee = 0.7;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    const shaped =
      magnitude <= knee ? magnitude : knee + Math.tanh((magnitude - knee) / 0.3) * 0.28;
    curve[i] = Math.sign(x) * shaped;
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  return shaper;
}

function offlineContext(channels: number, length: number, sampleRate: number): OfflineAudioContext {
  const Ctor: OfflineCtor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: OfflineCtor }).webkitOfflineAudioContext;
  if (!Ctor) throw new Error('This browser cannot mix audio offline.');
  return new Ctor(channels, length, sampleRate);
}

/**
 * Schedule the full music envelope — fade in, duck, fade out — onto a gain node.
 *
 * One `setValueCurveAtTime` covers the lot, which keeps the curve identical to
 * what `musicGainAt` × `duckGainAt` say it is. Some older engines implement that
 * call badly or not at all, so a stepped fallback repeats the same numbers as
 * plain set-values.
 */
function scheduleMusicEnvelope(
  gain: GainNode,
  level: number,
  duration: number,
  fadeSeconds: number,
  duck: DuckEnvelope | null,
): void {
  const steps = Math.max(2, Math.ceil(duration * DUCK_RATE));
  const curve = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const elapsed = (i / steps) * duration;
    curve[i] = level * musicGainAt(elapsed, duration, fadeSeconds) * duckGainAt(duck, elapsed);
  }
  try {
    gain.gain.setValueAtTime(curve[0], 0);
    gain.gain.setValueCurveAtTime(curve, 0, duration);
    return;
  } catch {
    // Fall through to the stepped version below.
  }
  gain.gain.cancelScheduledValues(0);
  for (let i = 0; i <= steps; i++) {
    gain.gain.setValueAtTime(curve[i], (i / steps) * duration);
  }
}

/**
 * Render voice + music down to one stereo buffer at the voice's length.
 *
 * Always goes through the offline render, even with no music and the voice slider
 * untouched: the channel count and sample rate normalisation below is the point,
 * and skipping it for the simple case would mean the simple case is the one that
 * ships a mono file.
 */
export async function mixAudio(request: MixRequest): Promise<AudioBuffer> {
  const { voice, music, voiceVolume, musicVolume } = request;
  const fadeSeconds = request.fadeSeconds ?? MUSIC_FADE_SECONDS;
  const level = effectiveMusicLevel(musicVolume, voiceVolume);
  const withMusic = Boolean(music && music.length > 0 && level > 0.0005);

  const sampleRate = ACCEPTED_SAMPLE_RATES.includes(voice.sampleRate)
    ? voice.sampleRate
    : PLATFORM_SAMPLE_RATE;
  // Resampling changes the frame count; the duration is what has to be preserved.
  const length = Math.max(1, Math.round(voice.duration * sampleRate));
  const context = offlineContext(MIX_CHANNELS, length, sampleRate);
  const duration = voice.duration;

  const limiter = softLimiter(context);
  limiter.connect(context.destination);

  const voiceSource = context.createBufferSource();
  voiceSource.buffer = voice;
  const voiceGain = context.createGain();
  voiceGain.gain.value = clamp01(voiceVolume);
  voiceSource.connect(voiceGain);
  voiceGain.connect(limiter);
  voiceSource.start(0);

  if (withMusic && music) {
    const musicSource = context.createBufferSource();
    musicSource.buffer = music;
    // Shorter than the voice: repeats. Longer: the render ends first, so it is
    // trimmed. Neither case needs a special path.
    musicSource.loop = true;

    const musicGain = context.createGain();
    const duck = request.duck ?? buildDuckEnvelope(voice);
    scheduleMusicEnvelope(musicGain, level, duration, fadeSeconds, duck);

    musicSource.connect(musicGain);
    musicGain.connect(limiter);
    musicSource.start(0);
  }

  return context.startRendering();
}
