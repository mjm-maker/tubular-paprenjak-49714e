/**
 * Browser half of the subtitle pipeline.
 *
 * The two API routes want small slices of 16 kHz mono WAV, so this is where a
 * decoded voice buffer becomes exactly that: cut at pauses rather than on a fixed
 * grid (a boundary through the middle of a word costs a word in the transcript),
 * downsampled in an `OfflineAudioContext`, and uploaded one slice at a time so a
 * three-minute recording never becomes one enormous request.
 *
 * Everything here reports progress and awaits between slices, so the interface keeps
 * painting while a long recording is being transcribed.
 */

import { type AudioAnalysis } from './analysis';
import { normaliseCues, type SubtitleCue, type SubtitleLanguage } from './subtitles';

/** What the routes are told to expect, and what the model is happiest with. */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;

/** Slice length. Long enough for context, short enough for one function call. */
const SEGMENT_SECONDS = 40;
/** How far either side of a boundary we hunt for a pause to cut on. */
const SEARCH_SECONDS = 5;
/** Never leave a tail shorter than this; fold it into the previous slice instead. */
const MIN_TAIL_SECONDS = 6;
/** Cues per translation request. The route accepts 400; this leaves headroom. */
const TRANSLATE_BATCH = 60;

export type SubtitleErrorCode = 'not-configured' | 'rate-limited' | 'empty' | 'failed';

export class SubtitleError extends Error {
  code: SubtitleErrorCode;
  constructor(code: SubtitleErrorCode, message: string) {
    super(message);
    this.name = 'SubtitleError';
    this.code = code;
  }
}

export type TranscribeStage = 'prepare' | 'transcribe' | 'translate';

export interface TranscribeProgress {
  stage: TranscribeStage;
  /** 0..1 through this stage. */
  ratio: number;
  detail: string;
}

export interface TranscribeResult {
  /** The language actually spoken, as reported by the model. */
  language: SubtitleLanguage;
  cues: SubtitleCue[];
}

interface Slice {
  start: number;
  end: number;
}

/* -------------------------------------------------------------------------- */
/* Slicing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Find the quietest moment in `[from, to]` using the 240 Hz envelope the waveform
 * already runs on. Returns null when there is no envelope to look at, and the caller
 * falls back to cutting on the clock.
 */
function quietestPoint(analysis: AudioAnalysis, from: number, to: number): number | null {
  const rate = analysis.envRate;
  const env = analysis.env;
  if (!rate || !env || env.length === 0) return null;

  const first = Math.max(0, Math.round(from * rate));
  const last = Math.min(env.length - 1, Math.round(to * rate));
  if (last <= first) return null;

  // Average over a short window so one dip between two loud syllables does not win.
  const half = Math.max(1, Math.round(rate * 0.12));
  let bestIndex = first;
  let bestLevel = Infinity;
  for (let index = first; index <= last; index++) {
    let sum = 0;
    let count = 0;
    for (let offset = -half; offset <= half; offset++) {
      const at = index + offset;
      if (at < 0 || at >= env.length) continue;
      sum += env[at];
      count++;
    }
    const level = count > 0 ? sum / count : 1;
    if (level < bestLevel) {
      bestLevel = level;
      bestIndex = index;
    }
  }
  return bestIndex / rate;
}

/** Cut a recording into slices, preferring pauses over the clock. */
export function planSlices(duration: number, analysis: AudioAnalysis | null): Slice[] {
  if (duration <= SEGMENT_SECONDS + MIN_TAIL_SECONDS) {
    return [{ start: 0, end: duration }];
  }

  const slices: Slice[] = [];
  let start = 0;
  while (duration - start > SEGMENT_SECONDS + MIN_TAIL_SECONDS) {
    const target = start + SEGMENT_SECONDS;
    const found = analysis
      ? quietestPoint(analysis, Math.max(start + 8, target - SEARCH_SECONDS), Math.min(duration - 2, target + SEARCH_SECONDS))
      : null;
    const cut = found ?? target;
    slices.push({ start, end: cut });
    start = cut;
  }
  slices.push({ start, end: duration });
  return slices;
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render one slice down to mono at `TRANSCRIBE_SAMPLE_RATE`.
 *
 * Connecting a multi-channel buffer to a one-channel context downmixes it for free,
 * and the context's own sample rate does the resampling. Not every engine will build
 * a context at 16 kHz, so the rate degrades rather than the feature failing.
 */
async function renderMono(voice: AudioBuffer, slice: Slice): Promise<AudioBuffer> {
  const seconds = Math.max(0.1, slice.end - slice.start);
  const candidates = [TRANSCRIBE_SAMPLE_RATE, 22_050, voice.sampleRate];
  let lastError: unknown = null;

  for (const rate of candidates) {
    try {
      const frames = Math.max(1, Math.ceil(seconds * rate));
      const context = new OfflineAudioContext(1, frames, rate);
      const source = context.createBufferSource();
      source.buffer = voice;
      source.connect(context.destination);
      source.start(0, slice.start, seconds);
      return await context.startRendering();
    } catch (error) {
      lastError = error;
    }
  }

  throw new SubtitleError(
    'failed',
    lastError instanceof Error
      ? `The audio could not be prepared for transcription (${lastError.message}).`
      : 'The audio could not be prepared for transcription.',
  );
}

/** 16-bit PCM mono WAV. The smallest thing every decoder agrees about. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return bytes;
}

/** Chunked so a long recording does not blow the argument limit of `fromCharCode`. */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

interface ErrorBody {
  code?: string;
  error?: string;
}

async function readError(response: Response, fallback: string): Promise<SubtitleError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // Keep the fallback wording.
  }
  const message = typeof body.error === 'string' && body.error ? body.error : fallback;
  if (body.code === 'not-configured') return new SubtitleError('not-configured', message);
  if (response.status === 429) return new SubtitleError('rate-limited', message);
  return new SubtitleError('failed', message);
}

interface RawCue {
  start: number;
  end: number;
  text: string;
}

async function transcribeSlice(
  voice: AudioBuffer,
  slice: Slice,
  signal?: AbortSignal,
): Promise<{ language: SubtitleLanguage; cues: RawCue[] }> {
  const rendered = await renderMono(voice, slice);
  const wav = encodeWav(rendered.getChannelData(0), rendered.sampleRate);

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      audio: toBase64(wav),
      mimeType: 'audio/wav',
      offsetSeconds: slice.start,
      durationSeconds: slice.end - slice.start,
    }),
  });

  if (!response.ok) {
    throw await readError(response, 'Subtitles could not be generated. Please try again.');
  }

  const payload = (await response.json()) as { language?: unknown; cues?: unknown };
  const language: SubtitleLanguage = payload.language === 'en' ? 'en' : 'bg';
  const cues = Array.isArray(payload.cues)
    ? (payload.cues as Array<{ start?: unknown; end?: unknown; text?: unknown }>)
        .map((cue) => ({
          start: Number(cue.start),
          end: Number(cue.end),
          text: typeof cue.text === 'string' ? cue.text.trim() : '',
        }))
        .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text.length > 0)
    : [];

  return { language, cues };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export interface TranscribeOptions {
  voice: AudioBuffer;
  /** Used only to find pauses to cut on; transcription works without it. */
  analysis?: AudioAnalysis | null;
  signal?: AbortSignal;
  onProgress?: (progress: TranscribeProgress) => void;
}

/**
 * Transcribe a recording into cues in the language that was spoken.
 *
 * The returned cues carry text in one language only — `translateCues` fills the
 * other one when the user asks for the bilingual mode.
 */
export async function transcribeVoice(options: TranscribeOptions): Promise<TranscribeResult> {
  const { voice, analysis = null, signal, onProgress } = options;
  const report = (stage: TranscribeStage, ratio: number, detail: string) =>
    onProgress?.({ stage, ratio, detail });

  const slices = planSlices(voice.duration, analysis);
  report('prepare', 0, slices.length > 1 ? `Preparing ${slices.length} audio slices` : 'Preparing audio');

  const collected: RawCue[] = [];
  let language: SubtitleLanguage | null = null;

  for (let index = 0; index < slices.length; index++) {
    if (signal?.aborted) throw new SubtitleError('failed', 'Subtitle generation was cancelled.');
    report(
      'transcribe',
      index / slices.length,
      slices.length > 1 ? `Listening to part ${index + 1} of ${slices.length}` : 'Listening to your voice',
    );
    const result = await transcribeSlice(voice, slices[index], signal);
    // The first slice with actual speech decides the language for the whole clip.
    if (!language && result.cues.length > 0) language = result.language;
    collected.push(...result.cues);
  }

  if (collected.length === 0) {
    throw new SubtitleError(
      'empty',
      'No speech was recognised in this recording. Try a clearer recording, or turn subtitles off.',
    );
  }

  report('transcribe', 1, 'Tidying the timings');
  const spoken = language ?? 'bg';
  const cues = normaliseCues(
    collected.map((cue, index) => ({
      id: `c${index}`,
      start: cue.start,
      end: cue.end,
      bg: spoken === 'bg' ? cue.text : '',
      en: spoken === 'en' ? cue.text : '',
    })),
    voice.duration,
  );

  return { language: spoken, cues };
}

export interface TranslateOptions {
  cues: SubtitleCue[];
  from: SubtitleLanguage;
  to: SubtitleLanguage;
  signal?: AbortSignal;
  onProgress?: (progress: TranscribeProgress) => void;
}

/**
 * Fill in the second language, leaving the first one and every timing untouched.
 *
 * Cues are sent in batches with their ids attached and merged back by id, so a
 * reordered or partial answer cannot shift a translation onto the wrong cue.
 */
export async function translateCues(options: TranslateOptions): Promise<SubtitleCue[]> {
  const { cues, from, to, signal, onProgress } = options;
  const pending = cues.filter((cue) => cue[from].trim().length > 0);
  if (pending.length === 0 || from === to) return cues;

  const translations = new Map<string, string>();
  const batches: SubtitleCue[][] = [];
  for (let index = 0; index < pending.length; index += TRANSLATE_BATCH) {
    batches.push(pending.slice(index, index + TRANSLATE_BATCH));
  }

  for (let index = 0; index < batches.length; index++) {
    if (signal?.aborted) throw new SubtitleError('failed', 'Translation was cancelled.');
    onProgress?.({
      stage: 'translate',
      ratio: index / batches.length,
      detail: batches.length > 1 ? `Translating part ${index + 1} of ${batches.length}` : 'Translating subtitles',
    });

    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        from,
        to,
        segments: batches[index].map((cue) => ({ id: cue.id, text: cue[from] })),
      }),
    });

    if (!response.ok) {
      throw await readError(response, 'The subtitles could not be translated. Please try again.');
    }

    const payload = (await response.json()) as { segments?: unknown };
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    for (const item of segments) {
      const segment = item as { id?: unknown; text?: unknown };
      if (typeof segment.id === 'string' && typeof segment.text === 'string') {
        translations.set(segment.id, segment.text.trim());
      }
    }
  }

  onProgress?.({ stage: 'translate', ratio: 1, detail: 'Translating subtitles' });
  return cues.map((cue) => {
    const translated = translations.get(cue.id);
    if (!translated) return cue;
    return { ...cue, [to]: translated } as SubtitleCue;
  });
}

/** Download helper for the `.srt` / `.vtt` buttons. */
export function downloadText(text: string, filename: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
