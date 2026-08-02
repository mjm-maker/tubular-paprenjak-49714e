/**
 * Server-only access to the AI provider behind the subtitle features.
 *
 * Nothing in this file may ever be imported from a client component. The key it
 * reads is a server environment variable, and it is used to sign a request that
 * happens on the server — the browser only ever sees the JSON that comes back.
 * There is no fallback key, no key in the bundle, and no placeholder: when the
 * variable is missing, `resolveProvider()` says so and the route answers 503 with a
 * setup message instead of pretending.
 *
 * Transcription runs through Gemini because that is the multimodal model Netlify's
 * AI Gateway offers — the gateway has no dedicated speech-to-text endpoint, and
 * Gemini accepts audio directly and handles Bulgarian well. On Netlify the key and
 * base URL are injected automatically once the project has had one production
 * deploy; anywhere else, set `GEMINI_API_KEY` yourself.
 */

/**
 * Model used for transcription (audio in) and for translation (text in).
 *
 * Both are Flash rather than Pro, and that is a latency decision rather than a
 * quality one. This route has to answer inside the hosting platform's function
 * timeout, which is tens of seconds; Pro is a thinking model and spent longer than
 * that on a single slice of audio, so the function was killed and the user was told
 * only that subtitles "could not be generated". Flash returns the same schema over
 * the same audio in a fraction of the time, which is what makes the feature finish.
 */
export const TRANSCRIBE_MODEL = 'gemini-2.5-flash';
export const TRANSLATE_MODEL = 'gemini-2.5-flash';

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/**
 * How long one provider call may run before this route gives up on it.
 *
 * A function that overruns the platform's own ceiling is killed mid-flight, and what
 * reaches the browser is the platform's error page rather than this route's JSON —
 * unreadable, so it surfaces as a generic failure with no status in it. Timing the
 * call out here turns that into a clean 504 with a sentence the caller can show and
 * retry against.
 */
export const PROVIDER_TIMEOUT_MS = 25_000;

/** Statuses that mean what they say; anything else the provider invents becomes 502. */
const PASSTHROUGH_STATUS = new Set([400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504]);

const DEV = process.env.NODE_ENV !== 'production';

/**
 * Development-only trace of one provider call. Statuses, timings and the provider's
 * own reason — never the key, never the audio.
 */
function traceProvider(entry: Record<string, unknown>): void {
  if (!DEV) return;
  console.info('[glasko:provider]', JSON.stringify(entry));
}

export interface Provider {
  apiKey: string;
  baseUrl: string;
}

/**
 * The one place a key is read. Returns null when the environment has none, which is
 * the signal for a route to answer "not configured" rather than to guess.
 */
export function resolveProvider(): Provider | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.GOOGLE_GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE).replace(
    /\/+$/,
    '',
  );
  return { apiKey, baseUrl };
}

/** Body every route sends when the key is absent. Wording is shown to the user. */
export const NOT_CONFIGURED = {
  code: 'not-configured' as const,
  error:
    'Subtitles need a transcription key. Set GEMINI_API_KEY in the Netlify environment variables (or enable Netlify AI Gateway) and redeploy. Everything else in GLASKO works without it.',
};

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/**
 * Ask the model for JSON and return it parsed.
 *
 * `responseSchema` is passed through so the model is constrained rather than
 * trusted, but the text is still parsed defensively: a model that wraps its answer
 * in a fenced code block should not take a feature down.
 */
export async function generateJson<T>(options: {
  model: string;
  parts: Part[];
  systemInstruction: string;
  responseSchema?: unknown;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Give up on the provider after this long. Defaults to `PROVIDER_TIMEOUT_MS`. */
  timeoutMs?: number;
}): Promise<T> {
  const provider = resolveProvider();
  if (!provider) throw new ProviderError('No transcription key is configured.', 503);

  // One controller for two reasons to stop: the caller cancelling, and the deadline
  // expiring. Which of them fired decides what the caller is told, so it is recorded.
  const budget = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budget);
  const relay = () => controller.abort();
  options.signal?.addEventListener('abort', relay);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/v1beta/models/${options.model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.systemInstruction }] },
        contents: [{ role: 'user', parts: options.parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
          ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        },
      }),
    });
  } catch (error) {
    const failedAfter = Date.now() - startedAt;
    if (expired) {
      traceProvider({
        model: options.model,
        elapsedMs: failedAfter,
        status: 504,
        error: `no answer within ${budget} ms`,
      });
      throw new ProviderError(
        `The transcription service did not answer within ${Math.round(budget / 1000)} seconds.`,
        504,
      );
    }
    traceProvider({
      model: options.model,
      elapsedMs: failedAfter,
      status: 502,
      error: error instanceof Error ? error.message : 'unreachable',
    });
    throw new ProviderError('The transcription service could not be reached.', 502);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relay);
  }

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    // The provider's own message can contain request detail, so only the status and a
    // short reason travel back to the browser.
    const reason =
      response.status === 429
        ? 'The transcription service is rate limited right now. Try again in a minute.'
        : response.status === 401 || response.status === 403
          ? 'The transcription key was rejected. Check GEMINI_API_KEY in the Netlify environment.'
          : `The transcription service answered ${response.status}.`;
    traceProvider({ model: options.model, elapsedMs, status: response.status, error: reason });
    // The status is passed through rather than flattened to 502, because the caller
    // decides whether to try again from it: 429 and 5xx are worth another go, 400 is not.
    throw new ProviderError(reason, PASSTHROUGH_STATUS.has(response.status) ? response.status : 502);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

  if (!text.trim()) {
    // An empty answer has a named cause worth repeating. A model that spent its whole
    // token budget thinking reads as "unreadable JSON" otherwise, which sends whoever
    // debugs it looking at the parser instead of at the budget.
    const why = candidate?.finishReason ?? payload.promptFeedback?.blockReason ?? null;
    traceProvider({
      model: options.model,
      elapsedMs,
      status: 200,
      error: `empty answer (${why ?? 'no reason given'})`,
    });
    throw new ProviderError(
      why === 'MAX_TOKENS'
        ? 'The transcription service ran out of room before it finished this part.'
        : `The transcription service returned nothing${why ? ` (${why})` : ''}.`,
      502,
    );
  }

  traceProvider({ model: options.model, elapsedMs, status: 200, characters: text.length });
  return parseJson<T>(text);
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (braced.length > 2) candidates.push(braced);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next shape.
    }
  }
  throw new ProviderError('The transcription service returned something unreadable.', 502);
}
