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
 *
 * The timings that come back are the model's opinion, and a model tends to report a
 * cue slightly after the words it heard. `lib/align.ts` settles that against the
 * recording itself before the cues are returned, so callers only ever see cues that
 * sit on the speech.
 */

import { alignCuesToSpeech } from './align';
import { computeEnvelope, ENV_RATE, type AudioAnalysis } from './analysis';
import { normaliseCues, type SubtitleCue, type SubtitleLanguage } from './subtitles';

/** What the routes are told to expect, and what the model is happiest with. */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;

/**
 * Slice length.
 *
 * One slice is one `/api/transcribe` call, and that call has to finish inside the
 * hosting platform's function timeout — which is measured in tens of seconds. Forty
 * seconds of audio did not, so the very first request of a long recording was killed
 * by the platform before the model answered, and the whole transcript failed at
 * "part 1". Fifteen seconds is short enough to land well inside any such ceiling and
 * long enough to still carry a sentence or two of context for the model.
 */
const SEGMENT_SECONDS = 15;
/** How far either side of a boundary we hunt for a pause to cut on. */
const SEARCH_SECONDS = 2.5;
/** Never leave a tail shorter than this; fold it into the previous slice instead. */
const MIN_TAIL_SECONDS = 4;
/** Cues per translation request. The route accepts 400; this leaves headroom. */
const TRANSLATE_BATCH = 60;

export type SubtitleErrorCode =
  | 'not-configured'
  | 'rate-limited'
  | 'timeout'
  | 'empty'
  | 'failed';

export class SubtitleError extends Error {
  code: SubtitleErrorCode;
  /**
   * The cues from slices that did finish, when a later one failed.
   *
   * A two-minute recording is several requests. Throwing away eight of them because
   * the ninth timed out means transcribing the whole thing again, so the finished
   * work travels with the error and the caller decides whether to keep it.
   */
  partialCues?: SubtitleCue[];
  /** The language those partial cues are written in. */
  partialLanguage?: SubtitleLanguage;
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
      ? quietestPoint(
          analysis,
          Math.max(start + SEGMENT_SECONDS / 2, target - SEARCH_SECONDS),
          Math.min(duration - 2, target + SEARCH_SECONDS),
        )
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

/** One try plus two retries. */
const MAX_ATTEMPTS = 3;
/** The first retry waits this long, the second twice as long. */
const RETRY_BASE_MS = 700;
/**
 * How long the browser waits for one request before giving up on it.
 *
 * Deliberately longer than any platform's own function ceiling: this is the backstop
 * for a request that is hanging rather than one that is merely slow, so it must not
 * pre-empt a server that was about to answer.
 */
const REQUEST_TIMEOUT_MS = 40_000;
/**
 * Statuses worth another go. Everything else — a malformed request, a payload that is
 * too large, a rejected key — will fail in exactly the same way the second time.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Statuses that mean "took too long" rather than "went wrong". */
const TIMEOUT_STATUS = new Set([408, 504]);

const DEV = process.env.NODE_ENV !== 'production';

/**
 * Development-only trace of one request. Slice number, slice length, how long the
 * request took, the status, the attempt and the error — never the audio itself.
 */
function trace(entry: Record<string, unknown>): void {
  if (!DEV) return;
  console.info('[glasko:transcribe]', JSON.stringify(entry));
}

const since = (from: number) => Math.round(performance.now() - from);
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/** `setTimeout` that gives up when the run is cancelled rather than holding it open. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SubtitleError('failed', 'Subtitle generation was cancelled.'));
      return;
    }
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(new SubtitleError('failed', 'Subtitle generation was cancelled.'));
    };
    const timer = setTimeout(() => {
      settle();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `fetch` with a deadline of its own.
 *
 * The caller's abort signal and the deadline share one controller, and which of the
 * two fired is remembered — a cancelled run and a hung server have to be told apart,
 * because one is silent and the other is something the user should be told about.
 */
async function postJson(url: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);

  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (expired) {
      throw new SubtitleError(
        'timeout',
        `The server did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`,
      );
    }
    // The caller cancelling is not a failure — it is rethrown untouched so the page
    // can tell it apart from everything else and go quietly back to idle.
    if (signal?.aborted) throw error;
    throw new SubtitleError(
      'failed',
      'The transcription service could not be reached. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

interface ErrorBody {
  code?: string;
  error?: string;
}

/** Wording for a status that arrived without an explanation attached to it. */
function describeStatus(status: number, what: string): string {
  if (TIMEOUT_STATUS.has(status)) return `${what} timed out on the server (HTTP ${status}).`;
  if (status === 413) return `${what} was too large to send (HTTP 413).`;
  if (status === 429) return `The transcription service is rate limited right now (HTTP 429).`;
  if (status >= 500) return `The transcription service failed on ${what.toLowerCase()} (HTTP ${status}).`;
  return `The server refused ${what.toLowerCase()} (HTTP ${status}).`;
}

/**
 * Turn a failed response into an error the user can act on.
 *
 * The body is the first choice, because every route in this app answers with JSON
 * carrying an `error` sentence. A body that is *not* JSON did not come from a route
 * at all — it is the platform's own error page for a function that was killed or
 * never started — so the status goes into the message rather than being swallowed by
 * a generic "please try again" that hides a timeout behind a shrug.
 */
async function readError(response: Response, what: string): Promise<SubtitleError> {
  let body: ErrorBody = {};
  let explained = false;
  try {
    body = (await response.json()) as ErrorBody;
    explained = true;
  } catch {
    // Not JSON. The status is all there is to go on.
  }

  const stated = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : null;
  const described = describeStatus(response.status, what);
  const message = stated
    ? stated
    : explained
      ? described
      : `${described} The server sent no explanation, which usually means the request ran past the hosting platform's function time limit.`;

  if (body.code === 'not-configured') return new SubtitleError('not-configured', message);
  if (response.status === 429) return new SubtitleError('rate-limited', message);
  if (TIMEOUT_STATUS.has(response.status)) return new SubtitleError('timeout', message);
  return new SubtitleError('failed', message);
}

interface RawCue {
  start: number;
  end: number;
  text: string;
}

function readCues(payload: {
  language?: unknown;
  cues?: unknown;
}): { language: SubtitleLanguage; cues: RawCue[] } {
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

/**
 * Transcribe one slice, trying again when the failure is one that might not repeat.
 *
 * A rate limit, a gateway error and a request that timed out are all momentary: the
 * same audio sent a second later usually comes back. A 400 or a 413 is not, and
 * neither is a missing key — those throw immediately rather than making the user wait
 * out two retries for the same answer.
 */
async function transcribeSlice(
  voice: AudioBuffer,
  slice: Slice,
  index: number,
  total: number,
  signal?: AbortSignal,
): Promise<{ language: SubtitleLanguage; cues: RawCue[] }> {
  const seconds = slice.end - slice.start;
  const rendered = await renderMono(voice, slice);
  const wav = encodeWav(rendered.getChannelData(0), rendered.sampleRate);
  const payload = {
    audio: toBase64(wav),
    mimeType: 'audio/wav',
    offsetSeconds: slice.start,
    durationSeconds: seconds,
  };
  const what = total > 1 ? `Part ${index + 1} of ${total}` : 'The recording';
  const context = { slice: index + 1, of: total, seconds: oneDecimal(seconds) };

  let last: SubtitleError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new SubtitleError('failed', 'Subtitle generation was cancelled.');
    // A short exponential wait: 0.7s before the first retry, 1.4s before the second.
    if (attempt > 1) await delay(RETRY_BASE_MS * 2 ** (attempt - 2), signal);

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await postJson('/api/transcribe', payload, signal);
    } catch (error) {
      if (!(error instanceof SubtitleError)) throw error; // The caller cancelled.
      trace({ ...context, attempt, elapsedMs: since(startedAt), error: error.message });
      last = error; // A timeout and an unreachable server are both worth another go.
      continue;
    }

    const elapsedMs = since(startedAt);
    if (response.ok) {
      let body: { language?: unknown; cues?: unknown };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new SubtitleError('failed', `${what} came back in a shape GLASKO could not read.`);
      }
      const result = readCues(body);
      trace({ ...context, attempt, elapsedMs, status: 200, cues: result.cues.length });
      return result;
    }

    const failure = await readError(response, what);
    trace({ ...context, attempt, elapsedMs, status: response.status, error: failure.message });
    // A missing key is a 503, and no amount of retrying will configure it.
    if (failure.code === 'not-configured' || !RETRYABLE_STATUS.has(response.status)) throw failure;
    last = failure;
  }

  throw new SubtitleError(
    last?.code ?? 'failed',
    `${last?.message ?? `${what} could not be transcribed.`} Tried ${MAX_ATTEMPTS} times.`,
  );
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
 * Turn raw model cues into the finished, aligned article.
 *
 * The model's timings are a first guess; the recording is the source of truth. The
 * envelope the waveform animation already runs on says where the speech actually
 * starts, so the cues are pulled onto it here — once, before anything draws them, so
 * the preview, the MP4 and the sidecar files cannot disagree about when a line
 * appears. Reuse the analysis when the caller has one; a caller without one gets the
 * same envelope computed from the voice buffer rather than losing the fix.
 *
 * Shared by the finished transcript and by the partial one kept after a failure, so
 * a rescued half is timed exactly the way a whole one would have been.
 */
function finishCues(
  collected: RawCue[],
  spoken: SubtitleLanguage,
  voice: AudioBuffer,
  analysis: AudioAnalysis | null,
): SubtitleCue[] {
  const timed = normaliseCues(
    collected.map((cue, index) => ({
      id: `c${index}`,
      start: cue.start,
      end: cue.end,
      bg: spoken === 'bg' ? cue.text : '',
      en: spoken === 'en' ? cue.text : '',
    })),
    voice.duration,
  );
  const env = analysis?.env ?? computeEnvelope(voice);
  const envRate = analysis?.envRate ?? ENV_RATE;
  return alignCuesToSpeech(timed, { env, envRate, duration: voice.duration }).cues;
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
  trace({ event: 'plan', slices: slices.length, duration: oneDecimal(voice.duration) });

  const collected: RawCue[] = [];
  let language: SubtitleLanguage | null = null;

  for (let index = 0; index < slices.length; index++) {
    if (signal?.aborted) throw new SubtitleError('failed', 'Subtitle generation was cancelled.');
    report(
      'transcribe',
      index / slices.length,
      slices.length > 1 ? `Listening to part ${index + 1} of ${slices.length}` : 'Listening to your voice',
    );
    try {
      const result = await transcribeSlice(voice, slices[index], index, slices.length, signal);
      // The first slice with actual speech decides the language for the whole clip.
      if (!language && result.cues.length > 0) language = result.language;
      collected.push(...result.cues);
    } catch (error) {
      // A part that will not transcribe must not discard the parts that did. The
      // finished cues travel with the error, timed the same way the whole transcript
      // would have been, so the panel can keep them on screen.
      if (error instanceof SubtitleError && collected.length > 0) {
        error.partialLanguage = language ?? 'bg';
        error.partialCues = finishCues(collected, error.partialLanguage, voice, analysis);
      }
      throw error;
    }
  }

  if (collected.length === 0) {
    throw new SubtitleError(
      'empty',
      'No speech was recognised in this recording. Try a clearer recording, or turn subtitles off.',
    );
  }

  report('transcribe', 1, 'Aligning to the voice');
  const spoken = language ?? 'bg';
  return { language: spoken, cues: finishCues(collected, spoken, voice, analysis) };
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
      throw await readError(
        response,
        batches.length > 1 ? `Translation part ${index + 1} of ${batches.length}` : 'The translation',
      );
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
