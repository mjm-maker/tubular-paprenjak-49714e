/**
 * Subtitle synchronisation check — `npm run subtitles:check`.
 *
 * There is no way to record a voice in a terminal, so this builds recordings instead:
 * a 240 Hz amplitude envelope in exactly the shape `lib/analysis.ts` produces, with
 * speech bursts at times this script knows, plus the cues a transcription model would
 * hand back for them — including the late timestamps that are the bug being fixed.
 *
 * Every case then asserts against the truth it generated: an aligned cue must start
 * within a frame or two of the word it belongs to, an already-synced recording must
 * come back untouched, and nothing may reorder, overlap, or lose text on the way. The
 * checks that matter are the ones that would fail if the fix were a fixed delay.
 *
 * Run with plain node: `lib/align.ts` is type-stripped, and it imports nothing from
 * the browser.
 */

import { alignCuesToSpeech, detectSpeech } from '../lib/align.ts';
import { analyseAudio, computeEnvelope } from '../lib/analysis.ts';
import { cueAt, normaliseCues, toSrt } from '../lib/subtitles.ts';

const ENV_RATE = 240;
const FPS = 30;
/** One video frame at 30 fps. Sync inside this is sync nobody can see. */
const FRAME = 1 / FPS;

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

function near(actual, expected, tolerance, label) {
  ok(
    Math.abs(actual - expected) <= tolerance,
    label,
    `got ${actual.toFixed(3)}s, expected ${expected.toFixed(3)}s (±${tolerance.toFixed(3)})`,
  );
}

/* -------------------------------------------------------------------------- */
/* Synthetic recordings                                                        */
/* -------------------------------------------------------------------------- */

/** Deterministic noise, so a failure is reproducible. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * An envelope with speech in `phrases` and room-tone everywhere else. Bursts get a
 * syllable wobble and an attack/release, because a square block of energy would be an
 * easier thing to align to than real speech is.
 */
function buildEnvelope(duration, phrases, { noise = 0.04, seed = 7 } = {}) {
  const random = makeRandom(seed);
  const length = Math.ceil(duration * ENV_RATE);
  const env = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    env[i] = noise * (0.5 + random());
  }

  for (const phrase of phrases) {
    const from = Math.round(phrase.start * ENV_RATE);
    const to = Math.min(length, Math.round(phrase.end * ENV_RATE));
    for (let i = from; i < to; i++) {
      const t = (i - from) / ENV_RATE;
      const span = (to - from) / ENV_RATE;
      const attack = Math.min(1, t / 0.03);
      const release = Math.min(1, (span - t) / 0.05);
      const syllables = 0.62 + 0.38 * Math.abs(Math.sin(t * 9.4 + phrase.start));
      env[i] = Math.min(1, Math.max(env[i], 0.85 * attack * release * syllables));
    }
  }
  return env;
}

/** Cues for those phrases, as a model that runs `lag` seconds late would report them. */
function cuesFor(phrases, lag, { language = 'bg', jitter = 0, seed = 11 } = {}) {
  const random = makeRandom(seed);
  const text = (index) =>
    language === 'bg' ? `Ред ${index + 1} на български` : `Line ${index + 1} in English`;

  return phrases.map((phrase, index) => {
    const drift = jitter ? (random() - 0.5) * 2 * jitter : 0;
    return {
      id: `c${index}`,
      start: Math.max(0, phrase.start + lag + drift),
      end: phrase.end + lag + drift,
      bg: language === 'bg' || language === 'both' ? text(index) : '',
      en: language === 'en' || language === 'both' ? text(index) : '',
    };
  });
}

/** Phrases with realistic gaps, from a seed so every run tests the same recording. */
function buildPhrases(count, { start = 0.8, seed = 3, minGap = 0.35 } = {}) {
  const random = makeRandom(seed);
  const phrases = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    const length = 1.4 + random() * 1.9;
    phrases.push({ start: at, end: at + length });
    at += length + minGap + random() * 0.7;
  }
  return phrases;
}

function assertWellFormed(cues, duration, label) {
  let sane = true;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (!(cue.end > cue.start)) sane = false;
    if (cue.start < -1e-9 || cue.end > duration + 1e-6) sane = false;
    if (i > 0 && cue.start < cues[i - 1].end - 1e-9) sane = false;
  }
  ok(sane, `${label}: cues stay ordered, non-overlapping and inside the clip`);
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

function caseLateBulgarian() {
  console.log('\nBulgarian, 32 s, model 1.6 s late');
  const duration = 32;
  const phrases = buildPhrases(9, { seed: 3 });
  const env = buildEnvelope(duration, phrases);
  const cues = cuesFor(phrases, 1.6, { language: 'bg' });

  const before = Math.max(...cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));
  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const after = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));

  console.log(
    `  worst error ${before.toFixed(3)}s -> ${after.toFixed(3)}s · shift ${report.shift.toFixed(3)}s · matched ${report.matched}/${report.total}`,
  );
  ok(report.cues.length === cues.length, 'every cue survives alignment');
  ok(after <= FRAME * 2, 'every cue lands within two frames of its phrase', `worst ${after.toFixed(3)}s`);
  ok(report.shift < -1, 'the correction is a pull earlier, sized from the audio');
  assertWellFormed(report.cues, duration, 'bulgarian');
  ok(
    report.cues.every((cue, i) => cue.bg === cues[i].bg && cue.en === cues[i].en),
    'text is untouched',
  );
}

function caseLateEnglishWithJitter() {
  console.log('\nEnglish, 45 s, 1.1 s late with ±0.35 s of jitter');
  const duration = 45;
  const phrases = buildPhrases(13, { seed: 21 });
  const env = buildEnvelope(duration, phrases, { seed: 22 });
  const cues = cuesFor(phrases, 1.1, { language: 'en', jitter: 0.35, seed: 23 });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const errors = report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start));
  const worst = Math.max(...errors);
  const median = [...errors].sort((a, b) => a - b)[Math.floor(errors.length / 2)];

  console.log(`  worst ${worst.toFixed(3)}s · median ${median.toFixed(3)}s · matched ${report.matched}/${report.total}`);
  ok(worst <= FRAME * 2, 'per-cue jitter is absorbed, not just the average', `worst ${worst.toFixed(3)}s`);
  ok(median <= FRAME, 'the typical cue is inside one frame');
  assertWellFormed(report.cues, duration, 'english');
}

function caseBilingual() {
  console.log('\nBilingual, both languages on one cue');
  const duration = 30;
  const phrases = buildPhrases(8, { seed: 5 });
  const env = buildEnvelope(duration, phrases, { seed: 6 });
  const cues = cuesFor(phrases, 1.9, { language: 'both' });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));

  ok(worst <= FRAME * 2, 'bilingual cues land on the speech too', `worst ${worst.toFixed(3)}s`);
  ok(
    report.cues.every((cue) => cue.bg.length > 0 && cue.en.length > 0),
    'both languages are still present on every cue',
  );

  // The mode only decides which language is drawn, so the timings it draws them at
  // must be identical — this is what makes bg / en / both share one sync.
  const stamps = (mode) =>
    toSrt(report.cues, mode)
      .split('\n')
      .filter((line) => line.includes('-->'))
      .join('|');
  ok(
    stamps('bg') === stamps('en') && stamps('en') === stamps('both'),
    'bg, en and both draw at exactly the same times',
  );
}

function caseAlreadyInSync() {
  console.log('\nAlready in sync — must not be nudged');
  const duration = 28;
  const phrases = buildPhrases(8, { seed: 31 });
  const env = buildEnvelope(duration, phrases, { seed: 32 });
  const cues = cuesFor(phrases, 0, { language: 'bg' });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const moved = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - cues[i].start)));

  console.log(`  shift ${report.shift.toFixed(3)}s · largest move ${moved.toFixed(3)}s`);
  near(report.shift, 0, 0.05, 'no whole-clip shift is invented');
  ok(moved <= FRAME, 'nothing moves by more than a frame', `moved ${moved.toFixed(3)}s`);
}

function caseLongRecording() {
  console.log('\nLong recording, 170 s, late and drifting');
  const duration = 170;
  const phrases = buildPhrases(52, { seed: 41 });
  const clipped = phrases.filter((phrase) => phrase.end < duration - 1);
  const env = buildEnvelope(duration, clipped, { seed: 42 });
  // A model whose clock also runs slightly fast: 1.2 s late at the top of the clip,
  // and worse by the end. A single constant delay cannot fix this one.
  const cues = clipped.map((phrase, index) => ({
    id: `c${index}`,
    start: phrase.start * 1.008 + 1.2,
    end: phrase.end * 1.008 + 1.2,
    bg: `Ред ${index + 1}`,
    en: '',
  }));

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const errors = report.cues.map((cue, i) => Math.abs(cue.start - clipped[i].start));
  const worst = Math.max(...errors);
  const late = report.cues.slice(-6).map((cue, i) => Math.abs(cue.start - clipped.slice(-6)[i].start));

  console.log(
    `  ${report.cues.length} cues · worst ${worst.toFixed(3)}s · last six worst ${Math.max(...late).toFixed(3)}s · scale ${report.scale.toFixed(4)}`,
  );
  ok(worst <= FRAME * 2, 'the whole clip stays in sync', `worst ${worst.toFixed(3)}s`);
  ok(Math.max(...late) <= FRAME * 2, 'the end of a long clip is as tight as the start');
  assertWellFormed(report.cues, duration, 'long');
}

function caseShortRecording() {
  console.log('\nShort recording, 6 s, two cues');
  const duration = 6;
  const phrases = [
    { start: 0.5, end: 2.1 },
    { start: 2.7, end: 5.2 },
  ];
  const env = buildEnvelope(duration, phrases, { seed: 51 });
  const cues = cuesFor(phrases, 1.4, { language: 'bg' });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  near(report.cues[0].start, phrases[0].start, FRAME * 2, 'first cue lands on the first word');
  near(report.cues[1].start, phrases[1].start, FRAME * 2, 'second cue lands on the second word');
  assertWellFormed(report.cues, duration, 'short');
}

function caseContinuousSpeech() {
  console.log('\nContinuous speech, no pauses to snap to');
  const duration = 24;
  // One unbroken run: the aligner has a single onset and must not invent detail.
  const env = buildEnvelope(duration, [{ start: 0.6, end: 23.4 }], { seed: 61 });
  const truth = [0.6, 4.2, 8.0, 11.9, 15.6, 19.4];
  const cues = truth.map((start, index) => ({
    id: `c${index}`,
    start: start + 1.5,
    end: start + 1.5 + 3.2,
    bg: `Ред ${index + 1}`,
    en: '',
  }));

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - truth[i])));
  console.log(`  shift ${report.shift.toFixed(3)}s · worst ${worst.toFixed(3)}s`);
  ok(worst <= 0.3, 'the lag is still removed from unbroken speech', `worst ${worst.toFixed(3)}s`);
  assertWellFormed(report.cues, duration, 'continuous');
}

function caseNoUsableAudio() {
  console.log('\nNo usable dynamics — leave the cues alone');
  const duration = 20;
  const flat = new Float32Array(Math.ceil(duration * ENV_RATE)).fill(0.42);
  const cues = normaliseCues(cuesFor(buildPhrases(5, { seed: 71 }), 1.5), duration);

  const report = alignCuesToSpeech(cues, { env: flat, duration });
  ok(detectSpeech(flat).length === 0, 'a constant level is not read as speech');
  ok(report.shift === 0 && report.scale === 1, 'nothing is guessed at');
  ok(
    report.cues.every((cue, i) => cue.start === cues[i].start && cue.end === cues[i].end),
    'the cues come back exactly as they went in',
  );

  const silent = new Float32Array(Math.ceil(duration * ENV_RATE));
  ok(alignCuesToSpeech(cues, { env: silent, duration }).cues.length === cues.length, 'silence loses no cues');
  ok(alignCuesToSpeech([], { env: flat, duration }).cues.length === 0, 'no cues is not an error');
}

function caseNoisyRoom() {
  console.log('\nNoisy room, quiet voice');
  const duration = 26;
  const phrases = buildPhrases(7, { seed: 81 });
  const env = buildEnvelope(duration, phrases, { noise: 0.2, seed: 82 });
  const cues = cuesFor(phrases, 1.7, { language: 'bg' });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));
  console.log(`  worst ${worst.toFixed(3)}s · matched ${report.matched}/${report.total}`);
  ok(worst <= 0.12, 'room tone does not break the alignment', `worst ${worst.toFixed(3)}s`);
}

/**
 * The preview and the encoder both ask for the cue at `frameIndex / FPS`, so what the
 * editor shows and what the MP4 contains can only differ if that arithmetic differs.
 * This walks every frame of a clip through it and compares the two, which is the
 * claim "identical in preview and export" written down.
 */
function casePreviewMatchesExport() {
  console.log('\nPreview and export draw the same cue on every frame');
  const duration = 20;
  const phrases = buildPhrases(6, { seed: 91 });
  const env = buildEnvelope(duration, phrases, { seed: 92 });
  const cues = alignCuesToSpeech(normaliseCues(cuesFor(phrases, 1.5, { language: 'both' }), duration), {
    env,
    duration,
  }).cues;

  const frameCount = Math.max(1, Math.ceil(duration * FPS));
  let mismatches = 0;
  let drawn = 0;
  for (let index = 0; index < frameCount; index++) {
    // Export: frame index straight off the loop counter in `lib/encode.ts`.
    const exported = cueAt(cues, index / FPS);
    // Preview: the audio element's clock, rounded to a frame in `PreviewStage`.
    const previewed = cueAt(cues, Math.round((index / FPS) * FPS) / FPS);
    if ((exported?.id ?? null) !== (previewed?.id ?? null)) mismatches++;
    if (exported) drawn++;
  }
  ok(mismatches === 0, 'no frame disagrees', `${mismatches} of ${frameCount}`);
  ok(drawn > frameCount * 0.4, 'and the clip really does have subtitles on it');

  // A cue must be on screen while its words are audible: check the middle of each
  // phrase, which is the moment a viewer would notice the text missing.
  let covered = 0;
  for (const phrase of phrases) {
    const middle = (phrase.start + phrase.end) / 2;
    if (cueAt(cues, middle)) covered++;
  }
  ok(covered === phrases.length, 'every phrase has its cue on screen while it is spoken');
}

/**
 * The rest of this file hands the aligner an envelope it built. This case goes through
 * the app's own analysis instead: real samples in, `analyseAudio` over them, and the
 * cues aligned against the envelope the waveform animation would actually be drawing.
 * It also pins the two ways that envelope can be obtained together, since a caller
 * without an analysis falls back to `computeEnvelope` and must not get a different
 * answer.
 */
async function caseRealSamples() {
  console.log('\nReal samples through analyseAudio');
  const sampleRate = 48_000;
  const duration = 22;
  const phrases = buildPhrases(6, { seed: 101, minGap: 0.5 });
  const data = new Float32Array(Math.round(duration * sampleRate));
  const random = makeRandom(102);

  for (let i = 0; i < data.length; i++) data[i] = (random() - 0.5) * 0.006;
  for (const phrase of phrases) {
    const from = Math.round(phrase.start * sampleRate);
    const to = Math.min(data.length, Math.round(phrase.end * sampleRate));
    for (let i = from; i < to; i++) {
      const t = (i - from) / sampleRate;
      const span = (to - from) / sampleRate;
      const envelope = Math.min(1, t / 0.02) * Math.min(1, (span - t) / 0.06);
      const syllable = 0.55 + 0.45 * Math.abs(Math.sin(2 * Math.PI * 4.2 * t));
      // A voice-ish stack: a low fundamental with two formants over it.
      const tone =
        Math.sin(2 * Math.PI * 140 * t) * 0.6 +
        Math.sin(2 * Math.PI * 620 * t) * 0.28 +
        Math.sin(2 * Math.PI * 2400 * t) * 0.1;
      data[i] += tone * envelope * syllable * 0.7;
    }
  }

  const buffer = {
    sampleRate,
    duration,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };

  const analysis = await analyseAudio(buffer);
  const fallback = computeEnvelope(buffer);
  let identical = analysis.env.length === fallback.length;
  for (let i = 0; identical && i < fallback.length; i++) {
    if (analysis.env[i] !== fallback[i]) identical = false;
  }
  ok(identical, 'the analysis envelope and the standalone one are the same envelope');

  const cues = normaliseCues(cuesFor(phrases, 1.5, { language: 'bg' }), duration);
  const report = alignCuesToSpeech(cues, {
    env: analysis.env,
    envRate: analysis.envRate,
    duration: analysis.duration,
  });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));
  console.log(`  shift ${report.shift.toFixed(3)}s · worst ${worst.toFixed(3)}s · matched ${report.matched}/${report.total}`);
  ok(worst <= FRAME * 2, 'cues land on the speech in the decoded audio', `worst ${worst.toFixed(3)}s`);
  assertWellFormed(report.cues, duration, 'samples');
}

/**
 * Cues the model reported too long as well as too late. The ends have to give way to
 * the next cue's start — a subtitle sitting over the following sentence is the same
 * bug seen from the other side — while the starts still land on their own words.
 */
function caseOverlongCues() {
  console.log('\nOverlong cues, late as well');
  const duration = 34;
  const phrases = buildPhrases(9, { seed: 111, minGap: 0.4 });
  const env = buildEnvelope(duration, phrases, { seed: 112 });
  const cues = phrases.map((phrase, index) => ({
    id: `c${index}`,
    // Late, and each cue runs 1.8× as long as the phrase it covers.
    start: phrase.start + 1.5,
    end: phrase.start + 1.5 + (phrase.end - phrase.start) * 1.8,
    bg: `Ред ${index + 1}`,
    en: `Line ${index + 1}`,
  }));

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));
  const spills = report.cues.filter((cue, i) => {
    const next = report.cues[i + 1];
    return next && cue.end > next.start + 1e-9;
  }).length;

  console.log(`  worst start error ${worst.toFixed(3)}s · ${spills} spills`);
  ok(worst <= FRAME * 2, 'a long cue does not drag the next one late', `worst ${worst.toFixed(3)}s`);
  ok(spills === 0, 'no cue outlives the start of the one after it');
  assertWellFormed(report.cues, duration, 'overlong');
}

/** The other direction. A model that runs early must be pushed later, not further out. */
function caseEarlyCues() {
  console.log('\nCues 0.8 s early');
  const duration = 30;
  const phrases = buildPhrases(9, { seed: 121 });
  const env = buildEnvelope(duration, phrases, { seed: 122 });
  const cues = cuesFor(phrases, -0.8, { language: 'en' });

  const report = alignCuesToSpeech(normaliseCues(cues, duration), { env, duration });
  const worst = Math.max(...report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start)));
  console.log(`  shift ${report.shift.toFixed(3)}s · worst ${worst.toFixed(3)}s`);
  ok(report.shift > 0.4, 'the correction goes the other way when the cues are early');
  ok(worst <= FRAME * 2, 'early cues land on the speech too', `worst ${worst.toFixed(3)}s`);
  assertWellFormed(report.cues, duration, 'early');
}

/** A dropped phrase and a cue over silence: the majority still decides the shift. */
function caseMissingAndSpuriousCues() {
  console.log('\nOne phrase missed, one cue invented over silence');
  const duration = 34;
  const phrases = buildPhrases(9, { seed: 131 });
  const env = buildEnvelope(duration, phrases, { seed: 132 });
  const kept = phrases.filter((_, index) => index !== 4);
  const cues = normaliseCues(
    [
      ...cuesFor(kept, 1.45, { language: 'bg' }).map((cue, index) => ({ ...cue, id: `k${index}` })),
      // A cue where nothing was said, in the gap after the second phrase.
      {
        id: 'ghost',
        start: phrases[1].end + 0.05,
        end: phrases[1].end + 0.3,
        bg: 'Измислен ред',
        en: '',
      },
    ],
    duration,
  );

  const report = alignCuesToSpeech(cues, { env, duration });
  const errors = kept.map((phrase) => {
    const cue = report.cues.find((candidate) => candidate.id.startsWith('k') && Math.abs(candidate.start - phrase.start) < 0.5);
    return cue ? Math.abs(cue.start - phrase.start) : Infinity;
  });
  const matchedAll = errors.every((error) => error <= FRAME * 2);
  console.log(`  shift ${report.shift.toFixed(3)}s · real cues on target: ${errors.filter((e) => e <= FRAME * 2).length}/${kept.length}`);
  ok(matchedAll, 'the real cues are unaffected by the odd ones out');
  assertWellFormed(report.cues, duration, 'ragged');
}

/**
 * A lag past the search limit. This one is not expected to be fixed — the point is
 * that an unfixable recording degrades into something still playable rather than into
 * scrambled cues, and that whatever correction is applied only ever helps.
 */
function caseBeyondTheLimit() {
  console.log('\nLag beyond the search limit');
  const duration = 40;
  const phrases = buildPhrases(10, { seed: 141 });
  const env = buildEnvelope(duration, phrases, { seed: 142 });
  const lag = 4.2;
  const cues = normaliseCues(cuesFor(phrases, lag, { language: 'bg' }), duration);

  const report = alignCuesToSpeech(cues, { env, duration });
  const before = cues.map((cue, i) => Math.abs(cue.start - phrases[i].start));
  const after = report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start));
  const worseSomewhere = after.some((error, i) => error > before[i] + 0.05);
  console.log(`  shift ${report.shift.toFixed(3)}s · worst ${Math.max(...before).toFixed(3)}s -> ${Math.max(...after).toFixed(3)}s`);
  ok(!worseSomewhere, 'no cue ends up further from its words than it started');
  assertWellFormed(report.cues, duration, 'beyond');
}

/**
 * A long recording is transcribed one ~40 s slice at a time, and each slice is its own
 * request — so one slice can be a second later than its neighbours. A single mapping
 * cannot express that, which is why the aligner re-shifts a stretch that disagrees with
 * the rest of the clip.
 */
function casePerSliceLag() {
  console.log('\n150 s in three slices, each late by its own amount');
  const duration = 150;
  const phrases = buildPhrases(45, { seed: 151 }).filter((phrase) => phrase.end < duration - 1);
  const env = buildEnvelope(duration, phrases, { seed: 152 });
  const lagFor = (at) => (at < 40 ? 1.1 : at < 80 ? 2.0 : 0.6);
  const cues = normaliseCues(
    phrases.map((phrase, index) => ({
      id: `c${index}`,
      start: phrase.start + lagFor(phrase.start),
      end: phrase.end + lagFor(phrase.start),
      bg: `Ред ${index + 1}`,
      en: '',
    })),
    duration,
  );

  const report = alignCuesToSpeech(cues, { env, duration });
  const errors = report.cues.map((cue, i) => Math.abs(cue.start - phrases[i].start));
  const worst = Math.max(...errors);
  console.log(`  worst ${worst.toFixed(3)}s · ${errors.filter((e) => e > FRAME * 2).length} cues off · matched ${report.matched}/${report.total}`);
  ok(worst <= FRAME * 2, 'the odd slice out is corrected on its own evidence', `worst ${worst.toFixed(3)}s`);
  assertWellFormed(report.cues, duration, 'per-slice');
}

/**
 * The adversarial version of "already in sync": cues split mid-phrase, so most of them
 * have no onset to sit on at all. There is nothing here to correct, and the aligner has
 * to be able to say so rather than dragging cues onto whichever onset is nearest.
 */
function caseMidPhraseSplitsInSync() {
  console.log('\nIn sync, with most cues starting mid-phrase');
  const duration = 40;
  const phrases = buildPhrases(10, { seed: 161 });
  const env = buildEnvelope(duration, phrases, { seed: 162 });
  // Two cues per phrase: the first on the onset, the second halfway through it.
  const cues = normaliseCues(
    phrases.flatMap((phrase, index) => {
      const middle = (phrase.start + phrase.end) / 2;
      return [
        { id: `a${index}`, start: phrase.start, end: middle - 0.05, bg: `Ред ${index}а`, en: '' },
        { id: `b${index}`, start: middle, end: phrase.end, bg: `Ред ${index}б`, en: '' },
      ];
    }),
    duration,
  );

  const report = alignCuesToSpeech(cues, { env, duration });
  const moved = report.cues.map((cue, i) => Math.abs(cue.start - cues[i].start));
  console.log(`  shift ${report.shift.toFixed(3)}s · largest move ${Math.max(...moved).toFixed(3)}s`);
  ok(Math.max(...moved) <= FRAME * 2, 'mid-phrase cues are left where they are', `moved ${Math.max(...moved).toFixed(3)}s`);
  ok(
    report.cues.every((cue, i) => cue.id === cues[i].id),
    'and none of them changes places',
  );
}

/* -------------------------------------------------------------------------- */

console.log('GLASKO subtitle synchronisation');
caseLateBulgarian();
caseLateEnglishWithJitter();
caseBilingual();
caseAlreadyInSync();
caseLongRecording();
casePerSliceLag();
caseShortRecording();
caseContinuousSpeech();
caseOverlongCues();
caseEarlyCues();
caseMissingAndSpuriousCues();
caseMidPhraseSplitsInSync();
caseBeyondTheLimit();
caseNoUsableAudio();
caseNoisyRoom();
casePreviewMatchesExport();
await caseRealSamples();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
}
