/**
 * Transcription reliability check — `npm run transcribe:check`.
 *
 * A two-minute Bulgarian recording used to fail at "part 1 of 3": the slice was forty
 * seconds long, the request outran the hosting platform's function timeout, the
 * platform answered with an error page instead of this app's JSON, and the browser
 * turned that into "Subtitles could not be generated. Please try again." — a sentence
 * with no status, no part number and nothing to act on.
 *
 * There is no provider to call from a terminal, so this stubs `fetch` and drives the
 * real `transcribeVoice` against synthetic Bulgarian recordings whose phrase times
 * this script already knows. What it asserts is everything the fix promised: slices
 * are short and cut in the pauses, every part completes, cues come back in order and
 * exactly once, a momentary failure is retried and a permanent one is not, a platform
 * error page is reported with its status, and a part that fails late does not throw
 * away the parts that finished.
 *
 * Run with plain node: `lib/transcribe.ts` is type-stripped, and the two browser
 * things it touches — `OfflineAudioContext` and `fetch` — are stubbed below.
 */

const ENV_RATE = 240;
/** Matches `SEGMENT_SECONDS` in lib/transcribe.ts. Asserted, not imported. */
const SEGMENT_SECONDS = 15;
const SEARCH_SECONDS = 2.5;
const MIN_TAIL_SECONDS = 4;
/** Matches `MAX_ATTEMPTS`: one try plus two retries. */
const MAX_ATTEMPTS = 3;
/** Matches `MAX_BASE64_LENGTH` in app/api/transcribe/route.ts. */
const MAX_BASE64_LENGTH = 4_400_000;

let failures = 0;
let checks = 0;

function ok(condition, label, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Browser stubs                                                               */
/* -------------------------------------------------------------------------- */

/** Enough of an AudioBuffer for the slicer, the WAV encoder and the aligner. */
function makeBuffer(channelData, sampleRate) {
  return {
    sampleRate,
    length: channelData.length,
    numberOfChannels: 1,
    duration: channelData.length / sampleRate,
    getChannelData: () => channelData,
  };
}

/**
 * `renderMono` only wants the slice downmixed and resampled; nothing downstream reads
 * the samples, because the model is stubbed. Nearest-neighbour is therefore honest
 * enough, and it keeps the check fast.
 */
class StubOfflineAudioContext {
  constructor(channels, frames, sampleRate) {
    this.frames = frames;
    this.sampleRate = sampleRate;
    this.source = null;
  }
  createBufferSource() {
    const source = {
      buffer: null,
      connect: () => {},
      start: (_when, offset, duration) => {
        source.offset = offset;
        source.duration = duration;
      },
    };
    this.source = source;
    return source;
  }
  get destination() {
    return {};
  }
  async startRendering() {
    const input = this.source.buffer.getChannelData(0);
    const inputRate = this.source.buffer.sampleRate;
    const from = Math.round((this.source.offset ?? 0) * inputRate);
    const out = new Float32Array(this.frames);
    for (let index = 0; index < this.frames; index++) {
      const at = from + Math.round((index / this.sampleRate) * inputRate);
      out[index] = at < input.length ? input[at] : 0;
    }
    return makeBuffer(out, this.sampleRate);
  }
}

globalThis.OfflineAudioContext = StubOfflineAudioContext;

const { planSlices, transcribeVoice, SubtitleError } = await import('../lib/transcribe.ts');

/* -------------------------------------------------------------------------- */
/* Synthetic recordings                                                        */
/* -------------------------------------------------------------------------- */

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  'Гласът остава на устройството',
  'Записваш и виждаш веднага',
  'Субтитрите се появяват на думата',
  'Музиката се снишава под гласа',
  'Готовото видео е твое',
  'Няма нищо качено никъде',
  'Всичко се случва в браузъра',
  'Изтегли файла и го публикувай',
];

/**
 * A recording of `duration` seconds: phrases of `speech` seconds separated by pauses
 * of `pause` seconds, which is what gives the slicer somewhere quiet to cut.
 */
function makeRecording(duration, { speech = 2.6, pause = 0.9, seed = 11 } = {}) {
  const phrases = [];
  let at = 0.6;
  let index = 0;
  while (at + speech < duration - 0.3) {
    // Numbered so two slices returning the same line is a real duplicate rather than
    // the word list simply having come round again.
    phrases.push({
      start: at,
      end: at + speech,
      text: `${WORDS[index % WORDS.length]} №${index + 1}`,
    });
    at += speech + pause;
    index++;
  }

  const random = makeRandom(seed);
  const length = Math.ceil(duration * ENV_RATE);
  const env = new Float32Array(length);
  for (let i = 0; i < length; i++) env[i] = 0.03 * (0.5 + random());
  for (const phrase of phrases) {
    const from = Math.round(phrase.start * ENV_RATE);
    const to = Math.min(length, Math.round(phrase.end * ENV_RATE));
    for (let i = from; i < to; i++) {
      const t = (i - from) / ENV_RATE;
      const span = (to - from) / ENV_RATE;
      const shape = Math.min(1, t / 0.08) * Math.min(1, (span - t) / 0.12);
      env[i] += 0.55 * Math.max(0, shape) * (0.75 + 0.25 * Math.sin(t * 26));
    }
  }

  const sampleRate = 48_000;
  const samples = new Float32Array(Math.ceil(duration * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    const seconds = i / sampleRate;
    const level = env[Math.min(env.length - 1, Math.round(seconds * ENV_RATE))];
    samples[i] = level * Math.sin(2 * Math.PI * 180 * seconds);
  }

  return {
    phrases,
    voice: makeBuffer(samples, sampleRate),
    analysis: { env, envRate: ENV_RATE, duration },
  };
}

/* -------------------------------------------------------------------------- */
/* Stub route                                                                  */
/* -------------------------------------------------------------------------- */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What a platform returns when it kills a function: HTML, not this app's JSON. */
function platformErrorPage(status) {
  return new Response(`<html><body><h1>${status} Gateway Timeout</h1></body></html>`, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/**
 * Stand in for `/api/transcribe`.
 *
 * The cues it returns are every phrase that *overlaps* the slice, which is what a
 * model hearing that audio would report — so a boundary cut through the middle of a
 * phrase shows up as the same line twice, and the duplication check below has
 * something real to catch rather than being true by construction.
 *
 * `script` maps a slice index to a list of responses to give before succeeding.
 */
function installRoute({ phrases, script = {}, calls }) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({
      offset: body.offsetSeconds,
      seconds: body.durationSeconds,
      base64Length: body.audio.length,
      mimeType: body.mimeType,
    });

    const index = calls.filter((call) => call.offset === body.offsetSeconds).length - 1;
    const planned = script[Math.round(body.offsetSeconds * 1000)] ?? [];
    const staged = planned[index];
    if (staged) return staged();

    const start = body.offsetSeconds;
    const end = start + body.durationSeconds;
    const cues = phrases
      .filter((phrase) => phrase.end > start + 0.05 && phrase.start < end - 0.05)
      .map((phrase) => ({
        start: Math.max(0, phrase.start - start),
        end: Math.min(body.durationSeconds, phrase.end - start),
        text: phrase.text,
      }))
      // The route shifts a slice's cues into the whole recording's timeline before
      // answering, and the browser relies on that, so the stub does it the same way.
      .map((cue) => ({
        start: Math.max(0, cue.start) + start,
        end: Math.max(cue.start + 0.4, cue.end) + start,
        text: cue.text,
      }));
    return jsonResponse({ language: 'bg', cues });
  };
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

function checkSliceGeometry(label, duration) {
  const { phrases, analysis } = makeRecording(duration);
  const slices = planSlices(duration, analysis);

  console.log(`\n${label} — slicing (${slices.length} part${slices.length === 1 ? '' : 's'})`);

  ok(slices[0].start === 0, 'starts at zero');
  ok(Math.abs(slices[slices.length - 1].end - duration) < 1e-6, 'ends at the recording length');

  let contiguous = true;
  let longest = 0;
  for (let index = 0; index < slices.length; index++) {
    const slice = slices[index];
    longest = Math.max(longest, slice.end - slice.start);
    if (index > 0 && Math.abs(slice.start - slices[index - 1].end) > 1e-6) contiguous = false;
    if (slice.end <= slice.start) contiguous = false;
  }
  ok(contiguous, 'slices are contiguous with no gap and no overlap');

  // The ceiling that matters: one request has to fit inside a function timeout.
  ok(
    longest <= SEGMENT_SECONDS + SEARCH_SECONDS + MIN_TAIL_SECONDS + 0.01,
    'no slice is longer than the segment plus its search and tail allowance',
    `longest ${longest.toFixed(2)}s`,
  );
  ok(longest < 40, 'no slice is anywhere near the 40s that used to time out', `longest ${longest.toFixed(2)}s`);

  const insideAPhrase = slices
    .slice(0, -1)
    .filter((slice) => phrases.some((phrase) => slice.end > phrase.start + 0.1 && slice.end < phrase.end - 0.1));
  ok(insideAPhrase.length === 0, 'every cut lands in a pause rather than through a word');
}

async function checkTranscript(label, duration, { script = {}, expectFailure = null } = {}) {
  const { phrases, voice, analysis } = makeRecording(duration);
  const calls = [];
  installRoute({ phrases, script, calls });

  const parts = [];
  let thrown = null;
  let result = null;
  try {
    result = await transcribeVoice({
      voice,
      analysis,
      onProgress: ({ stage, detail }) => {
        if (stage === 'transcribe' && detail.startsWith('Listening')) parts.push(detail);
      },
    });
  } catch (error) {
    thrown = error;
  }

  console.log(`\n${label}`);

  if (expectFailure) {
    expectFailure({ thrown, calls, result });
    return;
  }

  ok(!thrown, 'the transcript completed', thrown ? thrown.message : '');
  if (!result) return;

  const slices = planSlices(duration, analysis);
  ok(parts.length === slices.length, `every one of the ${slices.length} parts was announced`);
  ok(
    calls.length >= slices.length,
    `every part was requested (${calls.length} request${calls.length === 1 ? '' : 's'})`,
  );
  ok(
    calls.every((call) => call.base64Length <= MAX_BASE64_LENGTH),
    'no request exceeds the route\'s payload ceiling',
    `largest ${Math.max(...calls.map((call) => call.base64Length))}`,
  );
  ok(
    calls.every((call) => call.mimeType === 'audio/wav'),
    'every request is sent as 16 kHz mono WAV',
  );

  const text = result.cues.map((cue) => cue.bg);
  ok(result.language === 'bg', 'the spoken language is reported as Bulgarian');
  ok(
    text.every((line) => /[Ѐ-ӿ]/.test(line)),
    'every cue is still Cyrillic',
  );

  const ordered = result.cues.every(
    (cue, index) => index === 0 || cue.start >= result.cues[index - 1].start,
  );
  ok(ordered, 'cues are returned in order');
  ok(
    result.cues.every((cue) => cue.end > cue.start),
    'no cue ends before it starts',
  );

  // The boundary test: each spoken phrase must appear exactly once across the whole
  // transcript, however many slices it was cut into.
  const counts = new Map();
  for (const line of text) counts.set(line, (counts.get(line) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
  ok(duplicated.length === 0, 'no line is duplicated around a slice boundary', duplicated.map(([line]) => line).join(', '));
  ok(
    counts.size === phrases.length,
    `all ${phrases.length} spoken phrases survived`,
    `got ${counts.size}`,
  );

  const expected = phrases.map((phrase) => phrase.text);
  const firstDifference = expected.findIndex((line, index) => text[index] !== line);
  ok(
    text.join('|') === expected.join('|'),
    'the transcript reads in the order it was spoken',
    firstDifference >= 0
      ? `at ${firstDifference}: expected "${expected[firstDifference]}", got "${text[firstDifference]}"`
      : '',
  );
}

/* -------------------------------------------------------------------------- */

console.log('Transcription reliability\n=========================');

checkSliceGeometry('10-second recording', 10);
checkSliceGeometry('45-second recording', 45);
checkSliceGeometry('2:02 recording', 122);

await checkTranscript('10-second recording — transcript', 10);
await checkTranscript('45-second recording — transcript', 45);
await checkTranscript('2:02 recording — transcript', 122);

// A slice that fails once with a gateway error and then answers.
await checkTranscript('2:02 recording — one part fails transiently, then answers', 122, {
  script: { 0: [() => jsonResponse({ error: 'The transcription service answered 503.' }, 503)] },
});

// Rate limit, then a server error, then success: both retries used, still completes.
await checkTranscript('2:02 recording — rate limited, then a 500, then answers', 122, {
  script: {
    0: [
      () => jsonResponse({ error: 'Rate limited.' }, 429),
      () => jsonResponse({ error: 'Boom.' }, 500),
    ],
  },
});

// A network that drops the request is the same kind of momentary failure as a 503.
await checkTranscript('2:02 recording — the network drops one request', 122, {
  script: {
    0: [
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  },
});

// The bug itself: the platform kills the function and returns its own error page.
await checkTranscript('the platform kills the first request', 122, {
  script: {
    0: Array.from({ length: MAX_ATTEMPTS }, () => () => platformErrorPage(504)),
  },
  expectFailure: ({ thrown, calls }) => {
    ok(thrown instanceof SubtitleError, 'a SubtitleError is thrown');
    ok(thrown?.code === 'timeout', 'it is reported as a timeout rather than a mystery', thrown?.code);
    ok(/504/.test(thrown?.message ?? ''), 'the message names the status the server gave', thrown?.message);
    ok(
      /time limit/i.test(thrown?.message ?? ''),
      'the message says what an unexplained status usually means',
      thrown?.message,
    );
    ok(
      !/^Subtitles could not be generated/.test(thrown?.message ?? ''),
      'the generic wording is gone',
      thrown?.message,
    );
    ok(calls.length === MAX_ATTEMPTS, `it was tried ${MAX_ATTEMPTS} times`, `got ${calls.length}`);
  },
});

// A permanent error must not be retried.
await checkTranscript('a malformed request is not retried', 122, {
  script: { 0: Array.from({ length: 4 }, () => () => jsonResponse({ error: 'Expected a JSON body.' }, 400)) },
  expectFailure: ({ thrown, calls }) => {
    ok(calls.length === 1, 'a 400 is tried exactly once', `got ${calls.length}`);
    ok(thrown?.message === 'Expected a JSON body.', 'the server\'s own sentence reaches the user', thrown?.message);
  },
});

await checkTranscript('an oversized slice is not retried', 122, {
  script: { 0: Array.from({ length: 4 }, () => () => jsonResponse({ error: 'Too large.' }, 413)) },
  expectFailure: ({ calls }) => ok(calls.length === 1, 'a 413 is tried exactly once', `got ${calls.length}`),
});

await checkTranscript('a missing key is not retried', 122, {
  script: {
    0: Array.from({ length: 4 }, () => () =>
      jsonResponse({ code: 'not-configured', error: 'Subtitles need a transcription key.' }, 503),
    ),
  },
  expectFailure: ({ thrown, calls }) => {
    ok(calls.length === 1, 'an unconfigured project is asked exactly once', `got ${calls.length}`);
    ok(thrown?.code === 'not-configured', 'the setup code survives so the panel stays calm', thrown?.code);
  },
});

// A late part failing must not discard the early ones.
{
  const duration = 122;
  const { phrases, voice, analysis } = makeRecording(duration);
  const slices = planSlices(duration, analysis);
  const lastOffset = Math.round(slices[slices.length - 1].start * 1000);
  const calls = [];
  installRoute({
    phrases,
    calls,
    script: { [lastOffset]: Array.from({ length: 4 }, () => () => jsonResponse({ error: 'Nope.' }, 400)) },
  });

  console.log('\n2:02 recording — the last part fails');
  let thrown = null;
  try {
    await transcribeVoice({ voice, analysis });
  } catch (error) {
    thrown = error;
  }

  ok(thrown instanceof SubtitleError, 'a SubtitleError is thrown');
  const kept = thrown?.partialCues ?? [];
  ok(kept.length > 0, 'the parts that finished are kept', `${kept.length} cues`);
  ok(thrown?.partialLanguage === 'bg', 'the language of the kept cues travels with them');
  ok(
    kept.every((cue, index) => index === 0 || cue.start >= kept[index - 1].start),
    'the kept cues are still in order',
  );
  const keptText = kept.map((cue) => cue.bg);
  ok(new Set(keptText).size === keptText.length, 'the kept cues contain no duplicates');
  ok(
    keptText.join('|') === phrases.slice(0, keptText.length).map((phrase) => phrase.text).join('|'),
    'the kept cues are the opening of the recording, in order',
  );
  ok(
    kept.every((cue) => cue.end <= duration + 1e-6),
    'the kept cues stay inside the recording',
  );
}

// Cancelling must stay silent: the page tells an abort apart from a failure by the
// signal, and a retry loop that swallowed it would keep working after Cancel.
{
  const duration = 122;
  const { phrases, voice, analysis } = makeRecording(duration);
  const calls = [];
  const controller = new AbortController();
  installRoute({
    phrases,
    calls,
    script: {
      0: [
        () => {
          controller.abort();
          return jsonResponse({ error: 'Gateway error.' }, 502);
        },
      ],
    },
  });

  console.log('\n2:02 recording — cancelled during a retry');
  let thrown = null;
  try {
    await transcribeVoice({ voice, analysis, signal: controller.signal });
  } catch (error) {
    thrown = error;
  }
  ok(thrown !== null, 'cancelling stops the run');
  ok(controller.signal.aborted, 'the signal is what the page will check');
  ok(calls.length === 1, 'no retry is sent after Cancel', `${calls.length} requests`);
}

console.log(`\n${checks - failures}/${checks} checks passed.`);if (failures > 0) {
  console.error(`${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
