/**
 * Subtitle translation, cue by cue.
 *
 * Bilingual mode needs the second language to line up with the first one cue for
 * cue, so the whole list is translated in a single request with its ids attached —
 * translating each cue on its own loses the context that makes a short fragment
 * translatable at all, and translating the joined text loses the timing.
 */

import {
  generateJson,
  NOT_CONFIGURED,
  ProviderError,
  resolveProvider,
  TRANSLATE_MODEL,
} from '@/lib/server/ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_SEGMENTS = 400;
const MAX_CHARS = 20_000;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          text: { type: 'STRING' },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['segments'],
};

const LANGUAGE_NAME = { bg: 'Bulgarian', en: 'English' } as const;
type Language = keyof typeof LANGUAGE_NAME;

function systemFor(from: Language, to: Language): string {
  return `You translate subtitles from ${LANGUAGE_NAME[from]} to ${LANGUAGE_NAME[to]}.

Rules:
- Return one translation per input segment, with the same "id". Never merge, split, drop or reorder segments.
- Each segment is one subtitle card that appears on screen for two or three seconds. Keep the translation about as short as the original so it still fits on one line.
- The segments are consecutive parts of one continuous piece of speech. Read them together for context, but translate each one in place.
- Translate meaning, not word for word. Keep the speaker's register: plain speech stays plain.
- ${LANGUAGE_NAME[to]} output must use that language's own script${to === 'bg' ? ' — Cyrillic, never transliteration' : ''}.
- Keep names, numbers and units as they are. Do not add explanations, notes or quotation marks that were not there.
- If a segment cannot be translated, return the original text for that id rather than an empty string.`;
}

export async function POST(request: Request) {
  if (!resolveProvider()) {
    return Response.json(NOT_CONFIGURED, { status: 503 });
  }

  let body: { from?: unknown; to?: unknown; segments?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const from = body.from === 'en' ? 'en' : body.from === 'bg' ? 'bg' : null;
  const to = body.to === 'en' ? 'en' : body.to === 'bg' ? 'bg' : null;
  if (!from || !to || from === to) {
    return Response.json({ error: 'Expected "from" and "to" to be different languages.' }, { status: 400 });
  }

  const incoming = Array.isArray(body.segments) ? body.segments : null;
  if (!incoming || incoming.length === 0) {
    return Response.json({ error: 'Expected a non-empty "segments" array.' }, { status: 400 });
  }
  if (incoming.length > MAX_SEGMENTS) {
    return Response.json({ error: 'Too many subtitle segments in one request.' }, { status: 413 });
  }

  const segments = incoming
    .map((segment) => segment as { id?: unknown; text?: unknown })
    .filter(
      (segment) =>
        typeof segment.id === 'string' &&
        typeof segment.text === 'string' &&
        segment.text.trim().length > 0,
    )
    .map((segment) => ({ id: segment.id as string, text: (segment.text as string).trim() }));

  if (segments.length === 0) {
    return Response.json({ error: 'Every segment was empty.' }, { status: 400 });
  }
  if (segments.reduce((total, segment) => total + segment.text.length, 0) > MAX_CHARS) {
    return Response.json({ error: 'Those subtitles are too long to translate at once.' }, { status: 413 });
  }

  try {
    const result = await generateJson<{ segments?: unknown }>({
      model: TRANSLATE_MODEL,
      parts: [{ text: JSON.stringify({ segments }) }],
      systemInstruction: systemFor(from, to),
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
    });

    const raw = Array.isArray(result.segments) ? result.segments : [];
    const byId = new Map<string, string>();
    for (const item of raw) {
      const segment = item as { id?: unknown; text?: unknown };
      if (typeof segment.id === 'string' && typeof segment.text === 'string') {
        byId.set(segment.id, segment.text.trim());
      }
    }

    // Answer in the order the caller asked, falling back to the original text so a
    // partial response never silently blanks a cue.
    const translated = segments.map((segment) => ({
      id: segment.id,
      text: byId.get(segment.id) || segment.text,
    }));

    return Response.json({ segments: translated }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'Translation failed. Please try again.' }, { status: 502 });
  }
}
