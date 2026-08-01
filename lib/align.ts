/**
 * Aligning subtitle cues to the voice that is actually on the timeline.
 *
 * Transcription timings come from a language model, not from forced alignment, and a
 * model reading a clip tends to report a cue a little after the words it heard —
 * often a second or two. That reads as subtitles trailing the speaker, and the model
 * is the wrong thing to argue with: the recording itself knows exactly where the
 * speech is, because `lib/analysis.ts` already measured it at 240 Hz for the waveform.
 *
 * So this module treats the audio as the source of truth and the model's numbers as a
 * first guess. It finds where speech starts and stops in the envelope, works out the
 * single time mapping that best lines the cues up with those runs, and then snaps each
 * cue onto the onset it belongs to. Nothing here is a fixed delay: every number is
 * measured from the recording in front of it, and a recording whose cues are already
 * in time comes back untouched (`shift` 0, `scale` 1). A recording with no usable
 * dynamics — a constant drone, or silence — is left alone rather than guessed at.
 *
 * It runs once, in `lib/transcribe.ts`, before the cues reach the page. That is what
 * makes the preview, the exported MP4 and the `.srt` / `.vtt` sidecars agree: they all
 * read the same aligned array, and neither the renderer nor the encoder knows this
 * step happened.
 */

import { ENV_RATE } from './analysis';
import { normaliseCues, type SubtitleCue } from './subtitles';

/** Resolution the mask cross-correlation runs at. Fine enough for a frame at 30 fps. */
const CORR_RATE = 100;
/** How far the cues may be moved as a whole. Beyond this, the guess is not credible. */
const MAX_SHIFT_SECONDS = 2.5;
/** How far from a cue we will look for the speech onset it belongs to. */
const MATCH_WINDOW = 0.7;
/** How far a stranded run of cues may be moved on its own evidence. */
const MAX_LOCAL_SHIFT_SECONDS = 2;
/** Cues that must agree before a stretch of the clip is moved by itself. */
const MIN_LOCAL_RUN = 2;
/** Bin width for the shift vote. Fine enough to land inside a video frame. */
const VOTE_BIN_SECONDS = 0.04;
/** How close a cue has to be to an onset to count as sitting on it. */
const SNAP_TOLERANCE = 0.25;
/** Overlap the shifted cues must reach before the shift is believed at all. */
const MIN_TRUSTED_OVERLAP = 0.18;
/** How much better than "no shift" the best shift has to be to be worth applying. */
const OVERLAP_MARGIN = 0.01;
/** Smoothing applied to the envelope before thresholding, in seconds. */
const SMOOTH_SECONDS = 0.05;
/** Runs shorter than this are noise, not words. */
const MIN_SPEECH_SECONDS = 0.1;
/** Gaps shorter than this are inside a phrase, not between two of them. */
const MIN_GAP_SECONDS = 0.16;
/** A cue must survive as something readable. */
const MIN_CUE_SECONDS = 0.4;
/** Two cues may sit this close together, and no closer. */
const MIN_CUE_GAP = 0.2;
/** Let a cue hang on slightly past the last syllable rather than clipping it. */
const TAIL_PAD_SECONDS = 0.12;
/** A clock-rate correction is only fitted from this many matches over this long. */
const MIN_SCALE_MATCHES = 6;
const MIN_SCALE_SPAN_SECONDS = 20;
/** Drift correction stays small: a big one means the match, not the clock, was wrong. */
const MAX_SCALE_DRIFT = 0.02;

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface AlignOptions {
  /** Peak envelope of the **voice** — never the mix, which the bed would smear. */
  env: Float32Array;
  envRate?: number;
  duration: number;
}

export interface AlignReport {
  cues: SubtitleCue[];
  /**
   * Seconds every cue moved by at the start of the clip. Negative means the model
   * was reporting the speech late, which is the usual direction.
   */
  shift: number;
  /** Correction on the model's clock rate. 1 when none was needed or trusted. */
  scale: number;
  /** How many cues were matched to a speech onset. */
  matched: number;
  total: number;
  segments: SpeechSegment[];
}

/* -------------------------------------------------------------------------- */
/* Where the speech is                                                         */
/* -------------------------------------------------------------------------- */

/** Moving average over `half * 2 + 1` envelope samples. */
function smoothEnvelope(env: Float32Array, half: number): Float32Array {
  if (half <= 0) return env;
  const out = new Float32Array(env.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < env.length; i++) {
    if (i === 0) {
      for (let j = 0; j <= half && j < env.length; j++) {
        sum += env[j];
        count++;
      }
    } else {
      const entering = i + half;
      const leaving = i - half - 1;
      if (entering < env.length) {
        sum += env[entering];
        count++;
      }
      if (leaving >= 0) {
        sum -= env[leaving];
        count--;
      }
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

function quantile(sorted: Float32Array, ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

/**
 * Voice activity, straight off the envelope.
 *
 * Thresholds are relative to this recording's own quiet and loud levels, so a close
 * mic and a noisy phone recording both get sensible boundaries. Two of them, opened
 * high and closed low, stop a wobble in the middle of a word from cutting the run in
 * two — and once a run opens, its start is walked back to where the level was last
 * genuinely down, because the loud threshold is crossed a few milliseconds *into* the
 * word and the point of this whole exercise is the moment it began.
 */
export function detectSpeech(env: Float32Array, envRate: number = ENV_RATE): SpeechSegment[] {
  if (!env || env.length === 0 || !envRate) return [];

  const smooth = smoothEnvelope(env, Math.max(1, Math.round(envRate * SMOOTH_SECONDS)));
  const sorted = Float32Array.from(smooth).sort();
  const floor = quantile(sorted, 0.15);
  const loud = quantile(sorted, 0.95);
  // Nothing to tell apart: a drone, a hiss, or silence. Leave the cues alone.
  if (loud - floor < 0.05) return [];

  const open = floor + (loud - floor) * 0.3;
  const close = floor + (loud - floor) * 0.16;

  const runs: SpeechSegment[] = [];
  let inSpeech = false;
  let startIndex = 0;

  for (let i = 0; i < smooth.length; i++) {
    const value = smooth[i];
    if (!inSpeech) {
      if (value < open) continue;
      inSpeech = true;
      // Walk back to the foot of the attack.
      let back = i;
      while (back > 0 && smooth[back - 1] >= close) back--;
      startIndex = back;
    } else if (value < close) {
      inSpeech = false;
      runs.push({ start: startIndex / envRate, end: i / envRate });
    }
  }
  if (inSpeech) runs.push({ start: startIndex / envRate, end: smooth.length / envRate });

  const merged: SpeechSegment[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run.start - last.end <= MIN_GAP_SECONDS) {
      last.end = Math.max(last.end, run.end);
      continue;
    }
    merged.push({ ...run });
  }
  return merged.filter((run) => run.end - run.start >= MIN_SPEECH_SECONDS);
}

/* -------------------------------------------------------------------------- */
/* How far off the cues are                                                    */
/* -------------------------------------------------------------------------- */

function maskFrom(spans: Array<{ start: number; end: number }>, length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const span of spans) {
    const from = Math.max(0, Math.round(span.start * CORR_RATE));
    const to = Math.min(length, Math.round(span.end * CORR_RATE));
    for (let i = from; i < to; i++) mask[i] = 1;
  }
  return mask;
}

/** Intersection over union of the cue mask shifted by `shiftIndex` and the speech mask. */
function overlapAt(cueMask: Uint8Array, speechMask: Uint8Array, shiftIndex: number): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < speechMask.length; i++) {
    const source = i - shiftIndex;
    const cue = source >= 0 && source < cueMask.length ? cueMask[source] : 0;
    const speech = speechMask[i];
    if (cue && speech) intersection++;
    if (cue || speech) union++;
  }
  return union > 0 ? intersection / union : 0;
}

/**
 * Candidate whole-clip shifts, voted for by the cues themselves.
 *
 * Every (cue start, speech onset) pair inside the search range puts a vote in a 40 ms
 * bin, and a constant lag makes one bin tower over the rest. Unlike an overlap score
 * this cares only about *starts*, so cues the model reported too long — or too many, or
 * too few — cannot pull the answer around, and a handful of bad cues lose to the crowd.
 */
function shiftVotes(cues: SubtitleCue[], segments: SpeechSegment[]): number[] {
  const bins = new Map<number, number>();
  for (const cue of cues) {
    for (const segment of segments) {
      const difference = segment.start - cue.start;
      if (Math.abs(difference) > MAX_SHIFT_SECONDS) continue;
      const bin = Math.round(difference / VOTE_BIN_SECONDS);
      // Neighbours get a half vote, so a peak split across a bin boundary still wins.
      for (let step = -1; step <= 1; step++) {
        bins.set(bin + step, (bins.get(bin + step) ?? 0) + (step === 0 ? 2 : 1));
      }
    }
  }
  return [...bins.entries()]
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
    .slice(0, 3)
    .map(([bin]) => bin * VOTE_BIN_SECONDS);
}

/** How many cues would sit on a speech onset if everything moved by `shift`. */
function matchesAt(cues: SubtitleCue[], segments: SpeechSegment[], shift: number): number {
  let matched = 0;
  for (const cue of cues) {
    if (nearestOnset(segments, cue.start + shift, SNAP_TOLERANCE) !== null) matched++;
  }
  return matched;
}

/**
 * The whole-clip shift that puts the most cues on a word.
 *
 * Cues on onsets is the primary measure, because that is the thing being fixed. The
 * overlap sweep is kept as a second opinion: speech with no pauses in it offers a
 * single onset to vote with, and there the shape of the run is all there is to go on.
 * Nothing is applied unless it beats leaving the cues alone, which is what keeps a
 * recording that is already in sync from being nudged.
 */
function estimateShift(cues: SubtitleCue[], segments: SpeechSegment[], duration: number): number {
  const length = Math.max(1, Math.ceil((duration + MAX_SHIFT_SECONDS) * CORR_RATE));
  const speechMask = maskFrom(segments, length);
  const cueMask = maskFrom(cues, length);

  const limit = Math.round(MAX_SHIFT_SECONDS * CORR_RATE);
  let sweepBest = 0;
  let sweepScore = -1;
  for (let shiftIndex = -limit; shiftIndex <= limit; shiftIndex++) {
    const score = overlapAt(cueMask, speechMask, shiftIndex);
    // `>` not `>=`, and the loop runs from negative to positive, so among equal
    // scores the earliest shift wins and ties never drift the cues later.
    if (score > sweepScore) {
      sweepScore = score;
      sweepBest = shiftIndex / CORR_RATE;
    }
  }

  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const shift of [0, ...shiftVotes(cues, segments), sweepBest]) {
    const key = Math.round(shift * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(shift);
  }

  const rate = (shift: number) => ({
    shift,
    matched: matchesAt(cues, segments, shift),
    overlap: overlapAt(cueMask, speechMask, Math.round(shift * CORR_RATE)),
  });
  const baseline = rate(0);
  let best = baseline;
  for (const candidate of candidates) {
    const scored = rate(candidate);
    const better =
      scored.matched > best.matched ||
      (scored.matched === best.matched && scored.overlap > best.overlap + OVERLAP_MARGIN);
    if (better) best = scored;
  }

  // Neither measure liked it better than where the cues already are, or the recording
  // and the cues have too little in common to draw a conclusion from.
  if (best.overlap < MIN_TRUSTED_OVERLAP) return 0;
  if (best.matched <= baseline.matched && best.overlap < baseline.overlap + OVERLAP_MARGIN) return 0;
  return best.shift;
}

/**
 * The shift for one run of cues that the whole-clip mapping left stranded.
 *
 * Same vote as `shiftVotes`, over a shorter range and one stretch of the timeline, and
 * accepted only when it lands most of the run on an onset — with at least two cues
 * agreeing, since a single cue near a single onset is a coincidence, not evidence.
 */
function estimateLocalShift(starts: number[], segments: SpeechSegment[]): number {
  const bins = new Map<number, number>();
  for (const start of starts) {
    for (const segment of segments) {
      const difference = segment.start - start;
      if (Math.abs(difference) > MAX_LOCAL_SHIFT_SECONDS) continue;
      const bin = Math.round(difference / VOTE_BIN_SECONDS);
      for (let step = -1; step <= 1; step++) {
        bins.set(bin + step, (bins.get(bin + step) ?? 0) + (step === 0 ? 2 : 1));
      }
    }
  }
  if (bins.size === 0) return 0;

  const landed = (shift: number) =>
    starts.filter((start) => nearestOnset(segments, start + shift, SNAP_TOLERANCE) !== null).length;
  const required = Math.max(MIN_LOCAL_RUN, Math.ceil(starts.length / 2));
  const baseline = landed(0);

  const candidates = [...bins.entries()]
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
    .slice(0, 3)
    .map(([bin]) => bin * VOTE_BIN_SECONDS);

  let best = 0;
  let bestLanded = baseline;
  for (const candidate of candidates) {
    const count = landed(candidate);
    if (count >= required && count > bestLanded) {
      best = candidate;
      bestLanded = count;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest speech onset to `time`, or null when the nearest one is too far to be it. */
function nearestOnset(segments: SpeechSegment[], time: number, window: number): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const segment of segments) {
    const gap = Math.abs(segment.start - time);
    if (gap < bestGap) {
      bestGap = gap;
      best = segment.start;
    }
    // Onsets are sorted, so once we are past `time` the gap only grows.
    if (segment.start > time && bestGap <= gap) break;
  }
  return best !== null && bestGap <= window ? best : null;
}

/** End of the last speech run this cue overlaps, which is where its words stop. */
function speechEndWithin(segments: SpeechSegment[], start: number, end: number): number | null {
  let found: number | null = null;
  for (const segment of segments) {
    if (segment.end <= start) continue;
    if (segment.start >= end) break;
    found = segment.end;
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Re-time cues onto the speech in `env`, and report what that took.
 *
 * Text — in either language — is never touched, so a cue's Bulgarian and English
 * strings keep the timing they share and switching subtitle mode stays free.
 */
export function alignCuesToSpeech(cues: SubtitleCue[], options: AlignOptions): AlignReport {
  const { env, envRate = ENV_RATE, duration } = options;
  const segments = detectSpeech(env, envRate);
  const idle: AlignReport = {
    cues,
    shift: 0,
    scale: 1,
    matched: 0,
    total: cues.length,
    segments,
  };
  if (cues.length === 0 || segments.length === 0 || !(duration > 0)) return idle;

  // 1. The coarse move: one shift for the whole clip.
  const shift = estimateShift(cues, segments, duration);

  // 2. Match each shifted cue to the onset it is nearest to, and let those pairs
  //    correct the shift — and, on a long clip with enough of them, the rate the
  //    model's clock ran at. A median keeps one bad pair from dragging the fit.
  const pairs: Array<{ model: number; actual: number }> = [];
  for (const cue of cues) {
    const onset = nearestOnset(segments, cue.start + shift, MATCH_WINDOW);
    if (onset !== null) pairs.push({ model: cue.start, actual: onset });
  }

  let scale = 1;
  let offset = shift;
  if (pairs.length > 0) {
    offset = median(pairs.map((pair) => pair.actual - pair.model));
    const span = pairs[pairs.length - 1].model - pairs[0].model;
    if (pairs.length >= MIN_SCALE_MATCHES && span >= MIN_SCALE_SPAN_SECONDS) {
      const meanModel = pairs.reduce((sum, p) => sum + p.model, 0) / pairs.length;
      const meanActual = pairs.reduce((sum, p) => sum + p.actual, 0) / pairs.length;
      let covariance = 0;
      let variance = 0;
      for (const pair of pairs) {
        covariance += (pair.model - meanModel) * (pair.actual - meanActual);
        variance += (pair.model - meanModel) ** 2;
      }
      if (variance > 1e-6) {
        const fitted = covariance / variance;
        scale = Math.min(1 + MAX_SCALE_DRIFT, Math.max(1 - MAX_SCALE_DRIFT, fitted));
        offset = median(pairs.map((pair) => pair.actual - pair.model * scale));
      }
    }
  }

  const mapped = (time: number) => time * scale + offset;

  // 3. Where a stretch of the clip disagrees with the whole, re-shift just that
  //    stretch. Slices are transcribed independently, so one 40-second slice can be a
  //    second later than its neighbours; a single mapping cannot express that, and the
  //    cues in the odd slice would be the only ones still trailing the voice. A run is
  //    only moved when the move puts most of its cues on an onset and beats leaving it
  //    alone, so this cannot manufacture a shift where there is no evidence for one.
  const mappedStarts = cues.map((cue) => Math.max(0, mapped(cue.start)));
  const mappedEnds = cues.map((cue) => Math.max(0, mapped(cue.end)));

  let cursor = 0;
  while (cursor < cues.length) {
    if (nearestOnset(segments, mappedStarts[cursor], MATCH_WINDOW) !== null) {
      cursor++;
      continue;
    }
    let last = cursor;
    while (last + 1 < cues.length && nearestOnset(segments, mappedStarts[last + 1], MATCH_WINDOW) === null) {
      last++;
    }
    const run = mappedStarts.slice(cursor, last + 1);
    if (run.length >= MIN_LOCAL_RUN) {
      const local = estimateLocalShift(run, segments);
      if (local !== 0) {
        for (let index = cursor; index <= last; index++) {
          mappedStarts[index] += local;
          mappedEnds[index] += local;
        }
      }
    }
    cursor = last + 1;
  }

  // 4. Snap. The mapping gets each cue close; the onset puts it exactly on the word.
  //    Starts are decided first, on their own: a start is what a viewer notices, and
  //    letting the previous cue's end have a say in it is how one long cue drags the
  //    next one late. Ends then take whatever room is left up to the next start.
  const starts: number[] = [];
  let matched = 0;

  for (let index = 0; index < cues.length; index++) {
    const wanted = mappedStarts[index];
    const onset = nearestOnset(segments, wanted, MATCH_WINDOW);
    const floor = index > 0 ? starts[index - 1] + MIN_CUE_GAP : 0;
    const ceiling = Math.max(0, duration - MIN_CUE_GAP);
    const start = Math.min(ceiling, Math.max(floor, onset ?? wanted));
    if (onset !== null && Math.abs(start - onset) < 0.001) matched++;
    starts.push(start);
  }

  const aligned: SubtitleCue[] = cues.map((cue, index) => {
    const start = starts[index];
    // Never past the next cue's start: that cue has its own words to be on time for.
    const room = Math.min(duration, index + 1 < starts.length ? starts[index + 1] : duration);
    let end = Math.max(start, mappedEnds[index]);

    const spoken = speechEndWithin(segments, start, end + MATCH_WINDOW);
    if (spoken !== null && Math.abs(spoken - end) <= MATCH_WINDOW) {
      // Hang on a moment past the last syllable rather than clipping it.
      end = spoken + TAIL_PAD_SECONDS;
    }
    return { ...cue, start, end: Math.min(room, Math.max(end, start + MIN_CUE_SECONDS)) };
  });

  return {
    // The same tidy-up transcription already relies on, so a snap that pushed two
    // cues together cannot put two lines on screen at once.
    cues: normaliseCues(aligned, duration),
    shift: offset,
    scale,
    matched,
    total: cues.length,
    segments,
  };
}

/** `alignCuesToSpeech` for callers that only want the cues. */
export function alignCues(cues: SubtitleCue[], options: AlignOptions): SubtitleCue[] {
  return alignCuesToSpeech(cues, options).cues;
}
