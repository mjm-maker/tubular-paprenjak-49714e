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
 * `musicGainAt` is exported so the live preview can apply the same fade curve to
 * its `<audio>` element. Keeping one definition of the curve is what stops the
 * preview and the exported file from disagreeing.
 */

/** Short enough not to swallow the opening word, long enough not to click. */
export const MUSIC_FADE_SECONDS = 1.2;

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

export interface MixRequest {
  voice: AudioBuffer;
  music: AudioBuffer | null;
  /** 0..1 */
  voiceVolume: number;
  /** 0..1 */
  musicVolume: number;
  fadeSeconds?: number;
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
 * Render voice + music down to one buffer at the voice's length and sample rate.
 *
 * Returns the voice buffer untouched when there is nothing to do, so the common
 * no-music case costs nothing.
 */
export async function mixAudio(request: MixRequest): Promise<AudioBuffer> {
  const { voice, music, voiceVolume, musicVolume } = request;
  const fadeSeconds = request.fadeSeconds ?? MUSIC_FADE_SECONDS;
  const withMusic = Boolean(music && music.length > 0 && musicVolume > 0.0005);
  const voiceUnchanged = Math.abs(voiceVolume - 1) < 0.0005;

  if (!withMusic && voiceUnchanged) return voice;

  const channels = Math.min(
    2,
    Math.max(voice.numberOfChannels, withMusic && music ? music.numberOfChannels : 1),
  );
  const context = offlineContext(channels, voice.length, voice.sampleRate);
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
    const level = clamp01(musicVolume);
    const fade = fadeFor(duration, fadeSeconds);
    if (fade <= 0.001) {
      musicGain.gain.value = level;
    } else {
      // Same shape as musicGainAt: ramp up, hold, ramp down.
      musicGain.gain.setValueAtTime(0, 0);
      musicGain.gain.linearRampToValueAtTime(level, fade);
      musicGain.gain.setValueAtTime(level, Math.max(fade, duration - fade));
      musicGain.gain.linearRampToValueAtTime(0, duration);
    }

    musicSource.connect(musicGain);
    musicGain.connect(limiter);
    musicSource.start(0);
  }

  return context.startRendering();
}
