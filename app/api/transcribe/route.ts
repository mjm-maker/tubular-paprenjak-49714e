/**
 * Speech to text for one slice of a recording.
 *
 * The browser sends 16 kHz mono WAV — small enough to fit a function request, and
 * exactly what a speech model wants — plus the offset that slice starts at, and gets
 * back timed cues in the language that was actually spoken. Nothing is stored: the
 * audio exists for the length of the request and is never written anywhere.
 *
 * Voice audio does leave the device for this one feature, which is a real change
 * from the rest of GLASKO. It only happens when the user asks for subtitles, and the
 * UI says so before the first request.
 */

import {
  generateJson,
  NOT_CONFIGURED,
  ProviderError,
  resolveProvider,
  TRANSCRIBE_MODEL,
  type Part,
} from '@/lib/server/ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Transcribing a 45-second slice takes a while; the default 10s would cut it off. */
export const maxDuration = 60;

/** Roughly 3 MB of audio once decoded — inside every platform's request ceiling. */
const MAX_BASE64_LENGTH = 4_400_000;
const ALLOWED_MIME = ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'audio/mp4'];

interface RawCue {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING', enum: ['bg', 'en'] },
    cues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'NUMBER' },
          end: { type: 'NUMBER' },
          text: { type: 'STRING' },
        },
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['language', 'cues'],
};

const SYSTEM = `You are a subtitle transcriber for short spoken-voice social videos.

Rules:
- Transcribe verbatim in the language actually spoken. Do not translate.
- The speech is either Bulgarian or English. Report which one in "language" ("bg" or "en"). If both appear, report the one used for most of the clip.
- Bulgarian must be written in Cyrillic with correct spelling and diacritics-free standard orthography. Never transliterate Bulgarian into Latin letters.
- Split the transcript into short subtitle cues: at most 9 words or about 3.5 seconds each, broken at natural clause and sentence boundaries, never mid-word.
- "start" and "end" are seconds from the beginning of THIS audio clip, as decimals. They must increase, must not overlap, and must stay inside the clip's length.
- Punctuate and capitalise normally. Do not add speaker labels, timestamps inside the text, sound effects, or commentary.
- If the clip contains no intelligible speech, return an empty "cues" array.`;

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

export async function POST(request: Request) {
  // The key check comes first so an unconfigured project answers instantly and
  // clearly rather than after uploading audio it cannot use.
  if (!resolveProvider()) {
    return Response.json(NOT_CONFIGURED, { status: 503 });
  }

  let body: {
    audio?: unknown;
    mimeType?: unknown;
    offsetSeconds?: unknown;
    durationSeconds?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return badRequest('Expected a JSON body.');
  }

  const { audio, mimeType, offsetSeconds, durationSeconds } = body;
  if (typeof audio !== 'string' || audio.length === 0) {
    return badRequest('Expected base64 audio in "audio".');
  }
  if (audio.length > MAX_BASE64_LENGTH) {
    return Response.json(
      { error: 'That audio slice is too large. GLASKO should be sending shorter slices.' },
      { status: 413 },
    );
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME.includes(mimeType)) {
    return badRequest('Unsupported audio type.');
  }
  const offset = typeof offsetSeconds === 'number' && Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  const clipSeconds =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : null;

  const parts: Part[] = [
    {
      text: clipSeconds
        ? `Transcribe this ${clipSeconds.toFixed(1)}-second clip. Timestamps must be relative to the start of this clip.`
        : 'Transcribe this clip. Timestamps must be relative to the start of this clip.',
    },
    { inlineData: { mimeType, data: audio } },
  ];

  try {
    const result = await generateJson<{ language?: unknown; cues?: unknown }>({
      model: TRANSCRIBE_MODEL,
      parts,
      systemInstruction: SYSTEM,
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 8192,
    });

    const language = result.language === 'en' ? 'en' : 'bg';
    const raw = Array.isArray(result.cues) ? (result.cues as RawCue[]) : [];
    const cues = raw
      .map((cue) => ({
        start: Number(cue.start),
        end: Number(cue.end),
        text: typeof cue.text === 'string' ? cue.text.trim() : '',
      }))
      .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text.length > 0)
      // Shift into the whole recording's timeline here, so the browser never has to
      // know that the audio was cut into slices.
      .map((cue) => ({
        start: Math.max(0, cue.start) + offset,
        end: Math.max(cue.start + 0.4, cue.end) + offset,
        text: cue.text,
      }));

    return Response.json({ language, cues }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'Transcription failed. Please try again.' }, { status: 502 });
  }
}
