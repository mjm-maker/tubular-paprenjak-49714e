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

/** Model used for transcription (audio in) and for translation (text in). */
export const TRANSCRIBE_MODEL = 'gemini-2.5-pro';
export const TRANSLATE_MODEL = 'gemini-2.5-flash';

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com';

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
}): Promise<T> {
  const provider = resolveProvider();
  if (!provider) throw new ProviderError('No transcription key is configured.', 503);

  const response = await fetch(
    `${provider.baseUrl}/v1beta/models/${options.model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': provider.apiKey,
      },
      signal: options.signal,
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
    },
  );

  if (!response.ok) {
    // The provider's own message can contain request detail, so only the status and a
    // short reason travel back to the browser.
    const reason =
      response.status === 429
        ? 'The transcription service is rate limited right now. Try again in a minute.'
        : response.status === 401 || response.status === 403
          ? 'The transcription key was rejected. Check GEMINI_API_KEY in the Netlify environment.'
          : `The transcription service answered ${response.status}.`;
    throw new ProviderError(reason, response.status === 429 ? 429 : 502);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
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
