'use strict';

/**
 * Builds the GLASKO built-in music library.
 *
 *   npm run music:build
 *
 * Every track is synthesised from scratch here — oscillators, envelopes and a
 * wrap-around delay, no samples and no third-party audio of any kind. That is
 * deliberate: it means the library ships as public domain (CC0) with nothing to
 * clear, which is the only way to include music in the repository honestly.
 *
 * Loops are seamless because every voice writes through `add()`, which wraps
 * modulo the buffer length, so note tails and delay taps land back at the top of
 * the loop instead of being cut off.
 *
 * Output: public/music/*.mp3 plus public/music/library.json (the config the app
 * reads, including the real measured durations).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// lamejs
// ---------------------------------------------------------------------------

// lamejs' modules were written for a browser where each file left a global
// behind. Under CommonJS they have to be hung on `globalThis` by hand before the
// entry point can resolve them.
const LAME_MODULES = [
  'common', 'Version', 'MPEGMode', 'Lame', 'Presets', 'GainAnalysis',
  'QuantizePVT', 'Quantize', 'Takehiro', 'Reservoir', 'MeanBits', 'Encoder',
  'NewMDCT', 'III_psy_ratio', 'III_psy_xmin', 'IIISideInfo', 'L3Side',
  'ScaleFac', 'BitStream', 'VBRTag', 'VBRSeekInfo', 'VBRQuantize', 'PsyModel',
  'LameGlobalFlags', 'LameInternalFlags', 'ATH', 'CalcNoiseData',
  'CalcNoiseResult', 'FFT', 'GrInfo', 'ID3TagSpec', 'NsPsy', 'ReplayGain',
  'Tables', 'CBRNewIterationLoop',
];

for (const name of LAME_MODULES) {
  try {
    globalThis[name] = require(`lamejs/src/js/${name}.js`);
  } catch {
    // Not every name is a module in every lamejs release; the entry point below
    // only needs the ones that are.
  }
}

const lamejs = require('lamejs');

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

const SR = 32000;
const KBPS = 80;
const OUT_DIR = path.join(__dirname, '..', 'public', 'music');

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEMITONES = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** Note name (`'C4'`, `'Bb2'`) to frequency in Hz. */
function hz(name) {
  const match = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`Bad note name: ${name}`);
  const midi = SEMITONES[match[1]] + (Number(match[2]) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Wrap-around write. Everything goes through here so loops stay seamless. */
function add(buf, index, value) {
  const n = buf.length;
  buf[((index % n) + n) % n] += value;
}

function osc(kind, phase) {
  switch (kind) {
    case 'sine':
      return Math.sin(phase);
    case 'tri':
      return (2 / Math.PI) * Math.asin(Math.sin(phase));
    case 'warm': {
      // Six harmonics rolling off steeply: a soft, slightly hollow tone that
      // sits well under speech without any harsh upper partials.
      let v = 0;
      for (let n = 1; n <= 6; n++) v += Math.sin(phase * n) / Math.pow(n, 1.55);
      return v * 0.62;
    }
    case 'reed': {
      // Odd harmonics only — clarinet-ish, good for pads.
      let v = 0;
      for (let n = 1; n <= 9; n += 2) v += Math.sin(phase * n) / Math.pow(n, 1.35);
      return v * 0.7;
    }
    case 'saw': {
      let v = 0;
      for (let n = 1; n <= 12; n++) v += Math.sin(phase * n) / n;
      return v * 0.5;
    }
    default:
      return Math.sin(phase);
  }
}

function envelope(t, hold, a, d, s, r) {
  if (t < 0) return 0;
  if (t < a) return a <= 0 ? 1 : t / a;
  if (t < a + d) return d <= 0 ? s : 1 + (s - 1) * ((t - a) / d);
  if (t < hold) return s;
  const over = t - hold;
  if (over >= r) return 0;
  // Exponential-ish tail: quieter sooner, but never a hard edge.
  const x = 1 - over / r;
  return s * x * x;
}

function note(buf, opts) {
  const {
    f, t0, dur, gain = 0.2, kind = 'sine',
    a = 0.01, d = 0.12, s = 0.7, r = 0.35,
    vib = 0, vibRate = 5, detune = 0, pan = 0,
  } = opts;
  void pan;
  const start = Math.round(t0 * SR);
  const total = Math.round((dur + r) * SR);
  const w = 2 * Math.PI * f;
  const wd = 2 * Math.PI * f * (1 + detune);
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const e = envelope(t, dur, a, d, s, r);
    if (e <= 0.00002) continue;
    let phase = w * t;
    if (vib) phase += vib * Math.sin(2 * Math.PI * vibRate * t);
    let v = osc(kind, phase);
    if (detune) v = (v + osc(kind, wd * t)) * 0.62;
    add(buf, start + i, v * e * gain);
  }
}

function chord(buf, names, opts) {
  for (const name of names) note(buf, { ...opts, f: hz(name) });
}

/**
 * A continuous, perfectly seamless drone.
 *
 * A note with an attack and a release starts and ends near silence, which is fine
 * on its own — but the wrap-around delay carries the loud middle of the loop back
 * to bar one, so a fading-out tail meets a full-volume start and clicks. The fix
 * is to hold a constant amplitude the whole way round and snap the frequency (and
 * the tremolo rate) to a whole number of cycles per loop, so the waveform meets
 * itself exactly at the seam. All the oscillators here use integer harmonics, so
 * snapping the fundamental snaps every partial with it.
 */
function drone(buf, opts) {
  const { f, gain = 0.15, kind = 'reed', detune = 0, tremolo = 0, tremoloCycles = 4 } = opts;
  const period = buf.length / SR;
  const snap = (value) => Math.max(1, Math.round(value * period)) / period;
  const base = snap(f);
  const second = detune ? snap(f * (1 + detune)) : 0;
  const tremRate = tremolo ? snap(tremoloCycles / period) : 0;
  const w = 2 * Math.PI * base;
  const w2 = 2 * Math.PI * second;
  const wt = 2 * Math.PI * tremRate;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const amp = gain * (tremolo ? 1 - tremolo + tremolo * (0.5 + 0.5 * Math.cos(wt * t)) : 1);
    let v = osc(kind, w * t);
    if (second) v = (v + osc(kind, w2 * t)) * 0.62;
    buf[i] += v * amp;
  }
}

function kick(buf, t0, gain = 0.75) {
  const start = Math.round(t0 * SR);
  const total = Math.round(0.34 * SR);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const f = 46 + 128 * Math.exp(-t * 34);
    phase += (2 * Math.PI * f) / SR;
    const e = Math.exp(-t * 12) * (1 - Math.exp(-t * 900));
    add(buf, start + i, Math.sin(phase) * e * gain);
  }
}

function boom(buf, t0, gain = 0.7) {
  const start = Math.round(t0 * SR);
  const total = Math.round(1.6 * SR);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const f = 38 + 30 * Math.exp(-t * 6);
    phase += (2 * Math.PI * f) / SR;
    const e = Math.exp(-t * 2.4) * (1 - Math.exp(-t * 300));
    add(buf, start + i, Math.sin(phase) * e * gain);
  }
}

/** Noise burst, differentiated to push the energy up high (hat / shaker). */
function noiseHit(buf, t0, gain, decay, rng, tone = 1) {
  const start = Math.round(t0 * SR);
  const total = Math.round(Math.min(0.9, decay * 4) * SR);
  let prev = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    const n = rng() * 2 - 1;
    const high = n - prev * tone;
    prev = n;
    add(buf, start + i, high * Math.exp(-t / decay) * gain);
  }
}

function clap(buf, t0, gain, rng) {
  for (let k = 0; k < 3; k++) noiseHit(buf, t0 + k * 0.011, gain * (1 - k * 0.2), 0.045, rng, 0.82);
  noiseHit(buf, t0 + 0.034, gain * 0.9, 0.11, rng, 0.7);
}

/**
 * One-pole lowpass, in place.
 *
 * Loop-aware: the filter is run once to settle, and that final state seeds the
 * real pass. Starting from `buf[0]` instead would leave the filter in a different
 * state at the end than at the beginning, which puts a step in the loop seam.
 */
function lowpass(buf, cutoff) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (rc + dt);
  let y = buf[0];
  for (let i = 0; i < buf.length; i++) y += alpha * (buf[i] - y);
  for (let i = 0; i < buf.length; i++) {
    y += alpha * (buf[i] - y);
    buf[i] = y;
  }
}

/**
 * Gentle scoop through the speech band, in place.
 *
 * The one thing a music bed must not do is compete with the voice on top of it.
 * Speech lives roughly between 350 Hz and 3.5 kHz, so a broad, shallow dip there
 * leaves the bed's weight (its bass) and its air (its highs) intact while getting
 * out of the way of the words. Built from two passes of the loop-aware one-pole
 * above rather than a biquad, so it stays seamless at the loop point and stays
 * shallow enough that nothing sounds filtered.
 */
function duckMids(buf, low = 380, high = 3400, amount = 0.55) {
  const upper = Float32Array.from(buf);
  lowpass(upper, high);
  const lower = Float32Array.from(buf);
  lowpass(lower, low);
  for (let i = 0; i < buf.length; i++) buf[i] -= amount * (upper[i] - lower[i]);
}

/**
 * Feedback delay whose taps wrap around the end of the loop. This is what makes
 * the loop point inaudible: the tail of the last bar is already present at the
 * start of the first.
 */
function wrapDelay(buf, time, feedback, mix) {
  const out = Float32Array.from(buf);
  const step = Math.max(1, Math.round(time * SR));
  let g = feedback * mix;
  for (let k = 1; g > 0.012 && k < 48; k++) {
    const offset = step * k;
    for (let i = 0; i < buf.length; i++) {
      out[(i + offset) % buf.length] += buf[i] * g;
    }
    g *= feedback;
  }
  return out;
}

function softClip(buf) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * 1.08) * 0.94;
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function peak(buf) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  return max;
}

/**
 * Level-match to a common RMS so switching tracks in the picker does not jump in
 * loudness, then guarantee headroom.
 */
function master(buf, targetRms = 0.115) {
  const current = rms(buf);
  if (current > 0) {
    const gain = Math.min(6, targetRms / current);
    for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  }
  softClip(buf);
  const p = peak(buf);
  if (p > 0.92) {
    const gain = 0.92 / p;
    for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  }
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Build a bar-aligned context: `beat`/`bar` in seconds, plus a seeded RNG. */
function grid(bpm, bars, seed) {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const length = Math.round(bar * bars * SR);
  return { beat, bar, bars, buf: new Float32Array(length), rng: mulberry32(seed) };
}

const TRACKS = [
  {
    id: 'cinematic-03',
    title: 'Northern Light',
    category: 'Cinematic',
    file: 'northern-light.mp3',
    mood: 'Warm arpeggio over a wide pad — open and hopeful',
    build() {
      const { buf, beat, bar, rng } = grid(64, 8, 211);
      // Cmaj7 - Em7 - Am7 - Fmaj7: the modern, unresolved four that most
      // cinematic beds are built on, voiced low so speech sits above it.
      const progression = [
        ['C3', 'E3', 'G3', 'B3'],
        ['E3', 'G3', 'B3', 'D4'],
        ['A2', 'C3', 'E3', 'G3'],
        ['F2', 'A2', 'C3', 'E3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.96, gain: 0.062, kind: 'reed',
          a: 1.3, d: 1.0, s: 0.7, r: 1.8, detune: 0.0018,
        });
        // Sub root an octave down: the weight that makes it feel like a score.
        note(buf, {
          f: hz(voicing[0]) / 2, t0: t, dur: bar * 0.92, gain: 0.17,
          kind: 'sine', a: 0.6, d: 0.7, s: 0.62, r: 1.4,
        });
        // Eighth-note arpeggio, alternating up and down so it never marches.
        for (let e = 0; e < 8; e++) {
          const step = i % 2 === 0 ? e : 7 - e;
          const pitch = voicing[step % voicing.length];
          const octave = step >= 4 ? 2 : 1;
          note(buf, {
            f: hz(pitch) * octave,
            t0: t + e * (beat / 2) + rng() * 0.012,
            dur: 0.09,
            gain: 0.05 * (e % 2 === 0 ? 1 : 0.68),
            kind: 'warm', a: 0.004, d: 0.2, s: 0.1, r: 0.5,
          });
        }
      }
      // Two high sparkles per loop, off the grid.
      for (const [t0, pitch] of [[bar * 1.4, 'G5'], [bar * 5.6, 'C6']]) {
        note(buf, { f: hz(pitch), t0, dur: 0.1, gain: 0.028, kind: 'sine', a: 0.005, d: 0.5, s: 0.1, r: 1.6 });
      }
      duckMids(buf);
      lowpass(buf, 6800);
      return wrapDelay(buf, beat * 0.75, 0.4, 0.42);
    },
  },
  {
    id: 'cinematic-04',
    title: 'Long Shadow',
    category: 'Cinematic',
    file: 'long-shadow.mp3',
    mood: 'Slow minor swell with a cello-like low end',
    build() {
      const { buf, beat, bar } = grid(56, 8, 307);
      // i - VI - III - VII in D minor. Emotional without turning mournful.
      const progression = [
        ['D3', 'F3', 'A3'],
        ['Bb2', 'D3', 'F3'],
        ['F2', 'A2', 'C3'],
        ['C3', 'E3', 'G3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.9, gain: 0.07, kind: 'reed',
          a: 1.9, d: 1.2, s: 0.64, r: 2.2, detune: 0.0022, vib: 0.018, vibRate: 0.35,
        });
        // Bowed root: long attack, no transient, so it reads as a string section.
        note(buf, {
          f: hz(voicing[0]) / 2, t0: t, dur: bar * 0.95, gain: 0.15,
          kind: 'tri', a: 1.1, d: 0.8, s: 0.66, r: 1.6, vib: 0.02, vibRate: 4.2,
        });
      }
      // Sparse falling thirds, one every other bar.
      const figure = ['A4', 'F4', 'D4', 'C4', 'A3', 'F4'];
      for (let i = 0; i < figure.length; i++) {
        note(buf, {
          f: hz(figure[i]), t0: bar * 0.6 + i * bar * 1.3, dur: 0.2,
          gain: 0.045, kind: 'sine', a: 0.008, d: 0.7, s: 0.14, r: 2.4,
        });
      }
      // Two distant low hits mark the halves of the loop.
      boom(buf, 0, 0.3);
      boom(buf, bar * 4, 0.24);
      duckMids(buf, 340, 3200, 0.6);
      lowpass(buf, 5200);
      return wrapDelay(buf, beat * 1.5, 0.5, 0.55);
    },
  },
  {
    id: 'calm-03',
    title: 'Quiet Rooms',
    category: 'Calm',
    file: 'quiet-rooms.mp3',
    mood: 'Soft felt-piano motif, nothing else in the way',
    build() {
      const { buf, beat, bar, rng } = grid(60, 8, 419);
      const progression = [
        ['F3', 'A3', 'C4'],
        ['C3', 'E3', 'G3'],
        ['D3', 'F3', 'A3'],
        ['Bb2', 'D3', 'F3'],
      ];
      const motif = ['A4', 'C5', 'G4', 'F4', 'A4', 'D5', 'C5', 'G4'];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        chord(buf, progression[i % 4], {
          t0: t, dur: bar * 0.92, gain: 0.055, kind: 'reed',
          a: 1.5, d: 1.1, s: 0.66, r: 2.0, detune: 0.0015,
        });
        note(buf, {
          f: hz(progression[i % 4][0]) / 2, t0: t, dur: bar * 0.9, gain: 0.13,
          kind: 'sine', a: 0.7, d: 0.6, s: 0.6, r: 1.5,
        });
        // Two notes a bar, humanised in both time and level: the "felt piano"
        // feel comes from the unevenness, not from the timbre.
        for (const beatOffset of [0, 2.5]) {
          const pitch = motif[(i * 2 + (beatOffset > 0 ? 1 : 0)) % motif.length];
          const t0 = t + beatOffset * beat + rng() * 0.05;
          note(buf, {
            f: hz(pitch), t0, dur: 0.14,
            gain: 0.055 + rng() * 0.012, kind: 'sine', a: 0.006, d: 0.45, s: 0.13, r: 1.9,
          });
          // Hammer noise, barely audible, sells the mechanism.
          noiseHit(buf, t0, 0.006, 0.014, rng, 0.9);
        }
      }
      duckMids(buf, 400, 3000, 0.5);
      lowpass(buf, 4600);
      return wrapDelay(buf, beat, 0.44, 0.5);
    },
  },
  {
    id: 'inspirational-03',
    title: 'Small Victories',
    category: 'Inspirational',
    file: 'small-victories.mp3',
    mood: 'Plucked ostinato that lifts into a soft pulse',
    build() {
      const { buf, beat, bar, rng } = grid(88, 10, 523);
      const progression = [
        ['G3', 'B3', 'D4'],
        ['D3', 'F#3', 'A3'],
        ['E3', 'G3', 'B3'],
        ['C3', 'E3', 'G3'],
      ];
      const ostinato = ['D4', 'G4', 'B4', 'G4', 'A4', 'D5', 'B4', 'G4'];
      for (let i = 0; i < 10; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        // The pad only arrives in the second half — that is the "lift".
        const padGain = i < 4 ? 0.03 : 0.058;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.95, gain: padGain, kind: 'reed',
          a: 0.9, d: 0.8, s: 0.7, r: 1.4, detune: 0.002,
        });
        note(buf, {
          f: hz(voicing[0]) / 2, t0: t, dur: beat * 3.6, gain: 0.15,
          kind: 'tri', a: 0.06, d: 0.5, s: 0.55, r: 0.7,
        });
        for (let e = 0; e < 8; e++) {
          note(buf, {
            f: hz(ostinato[(e + i) % ostinato.length]),
            t0: t + e * (beat / 2) + rng() * 0.008,
            dur: 0.06,
            gain: 0.045 * (e % 2 === 0 ? 1 : 0.7),
            kind: 'warm', a: 0.003, d: 0.14, s: 0.08, r: 0.34,
          });
        }
        if (i >= 4) {
          kick(buf, t, 0.3);
          kick(buf, t + beat * 2, 0.22);
          for (let b = 0; b < 4; b++) {
            noiseHit(buf, t + b * beat + beat / 2, 0.026, 0.022, rng, 0.88);
          }
        }
      }
      duckMids(buf, 420, 3600, 0.5);
      lowpass(buf, 7600);
      return wrapDelay(buf, beat * 0.75, 0.3, 0.3);
    },
  },
  {
    id: 'cinematic-05',
    title: 'Slow Tide',
    category: 'Cinematic',
    file: 'slow-tide.mp3',
    mood: 'Tidal swells with no pulse at all',
    build() {
      // No tempo: a 34 second bed that breathes rather than counts.
      const seconds = 34;
      const buf = new Float32Array(Math.round(seconds * SR));
      const rng = mulberry32(631);
      // Four drones, each with its own tremolo rate. Because every rate is a
      // whole number of cycles per loop they all meet again at the seam.
      for (const [pitch, gain, tremolo, cycles] of [
        ['A1', 0.2, 0.1, 1],
        ['A2', 0.13, 0.26, 2],
        ['E3', 0.085, 0.34, 3],
        ['C#4', 0.05, 0.42, 5],
      ]) {
        drone(buf, { f: hz(pitch), gain, kind: 'reed', detune: 0.0016, tremolo, tremoloCycles: cycles });
      }
      // Breath: noise shaped by a slow swell, twice per loop.
      const swells = 2;
      for (let i = 0; i < buf.length; i++) {
        const phase = (i / buf.length) * swells * Math.PI * 2;
        const shape = Math.pow(0.5 - 0.5 * Math.cos(phase), 2.2);
        buf[i] += (rng() * 2 - 1) * 0.05 * shape;
      }
      // Rising sine that arrives at the loop point, so the seam feels intended.
      const riseFrom = Math.round(buf.length * 0.72);
      let phase = 0;
      for (let i = riseFrom; i < buf.length; i++) {
        const x = (i - riseFrom) / (buf.length - riseFrom);
        phase += (2 * Math.PI * (hz('A2') * (1 + x * 0.5))) / SR;
        buf[i] += Math.sin(phase) * 0.05 * x * x;
      }
      duckMids(buf, 320, 3000, 0.62);
      lowpass(buf, 3400);
      return wrapDelay(buf, 1.4, 0.55, 0.62);
    },
  },
  {
    id: 'business-02',
    title: 'Steady Hand',
    category: 'Business',
    file: 'steady-hand.mp3',
    mood: 'Marimba-style motif with a calm pulse',
    build() {
      const { buf, beat, bar, rng } = grid(100, 8, 127);
      const motif = ['C4', 'E4', 'G4', 'E4', 'F4', 'A4', 'C5', 'A4'];
      const roots = ['C2', 'C2', 'F1', 'G1'];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        for (let e = 0; e < 8; e++) {
          const pitch = motif[(e + i) % motif.length];
          note(buf, {
            f: hz(pitch),
            t0: t + e * (beat / 2),
            dur: 0.07,
            gain: 0.075 * (e % 2 === 0 ? 1 : 0.72),
            kind: 'sine', a: 0.002, d: 0.13, s: 0.06, r: 0.28,
          });
          // Octave doubling gives the marimba its woody attack.
          note(buf, { f: hz(pitch) * 2, t0: t + e * (beat / 2), dur: 0.03, gain: 0.02, kind: 'sine', a: 0.001, d: 0.05, s: 0.04, r: 0.1 });
        }
        note(buf, { f: hz(roots[i % 4]), t0: t, dur: beat * 3.5, gain: 0.16, kind: 'tri', a: 0.02, d: 0.4, s: 0.5, r: 0.45 });
        kick(buf, t, 0.38);
        kick(buf, t + beat * 2.5, 0.3);
        for (let b = 0; b < 4; b++) noiseHit(buf, t + b * beat + beat / 2, 0.032, 0.026, rng, 0.87);
      }
      lowpass(buf, 8000);
      return wrapDelay(buf, beat * 0.75, 0.26, 0.24);
    },
  },
  {
    id: 'business-03',
    title: 'Clear Signal',
    category: 'Business',
    file: 'clear-signal.mp3',
    mood: 'Understated modern pulse for talking over',
    build() {
      const { buf, beat, bar, rng } = grid(104, 12, 733);
      // Sus2 voicings: forward-moving without the corporate major-chord grin.
      const progression = [
        ['A3', 'B3', 'E4'],
        ['G3', 'A3', 'D4'],
        ['D3', 'E3', 'A3'],
        ['E3', 'F#3', 'B3'],
      ];
      const figure = ['E4', 'A4', 'B4', 'A4', 'D5', 'B4', 'A4', 'E4'];
      for (let i = 0; i < 12; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.94, gain: 0.042, kind: 'reed',
          a: 0.8, d: 0.7, s: 0.72, r: 1.2, detune: 0.0018,
        });
        note(buf, {
          f: hz(voicing[0]) / 2, t0: t, dur: beat * 3.7, gain: 0.14,
          kind: 'tri', a: 0.05, d: 0.45, s: 0.55, r: 0.6,
        });
        // Bell figure on the off-beats only, so the downbeat stays clear for speech.
        for (let e = 0; e < 4; e++) {
          note(buf, {
            f: hz(figure[(e + i * 2) % figure.length]),
            t0: t + e * beat + beat * 0.5,
            dur: 0.06,
            gain: 0.038,
            kind: 'sine', a: 0.002, d: 0.12, s: 0.06, r: 0.3,
          });
        }
        // Percussion holds back for the first third.
        if (i >= 4) {
          kick(buf, t, 0.24);
          if (i % 2 === 1) kick(buf, t + beat * 2.5, 0.18);
          for (let b = 0; b < 4; b++) noiseHit(buf, t + b * beat + beat / 2, 0.022, 0.02, rng, 0.9);
        }
      }
      duckMids(buf, 450, 3800, 0.45);
      lowpass(buf, 7200);
      return wrapDelay(buf, beat * 0.75, 0.24, 0.24);
    },
  },
  {
    id: 'ambient-03',
    title: 'Warm Static',
    category: 'Ambient',
    file: 'warm-static.mp3',
    mood: 'Tape-warm chords under a soft layer of air',
    build() {
      const seconds = 32;
      const buf = new Float32Array(Math.round(seconds * SR));
      const rng = mulberry32(857);
      // One chord every eight seconds, each one overlapping the next.
      const chords = [
        ['Eb3', 'G3', 'Bb3'],
        ['Bb2', 'D3', 'F3'],
        ['C3', 'Eb3', 'G3'],
        ['Ab2', 'C3', 'Eb3'],
      ];
      for (let i = 0; i < chords.length; i++) {
        chord(buf, chords[i], {
          t0: i * 8, dur: 7.4, gain: 0.075, kind: 'warm',
          a: 2.4, d: 1.6, s: 0.6, r: 3.2, detune: 0.0026,
        });
        note(buf, {
          f: hz(chords[i][0]) / 2, t0: i * 8, dur: 7.6, gain: 0.15,
          kind: 'sine', a: 1.2, d: 1.0, s: 0.6, r: 2.4,
        });
      }
      // Steady air. Level is constant across the loop, so there is no seam in it.
      let prev = 0;
      for (let i = 0; i < buf.length; i++) {
        const n = rng() * 2 - 1;
        // Slight low-pass on the noise itself keeps it warm rather than hissy.
        prev = prev * 0.86 + n * 0.14;
        buf[i] += prev * 0.09;
      }
      // Wow: a slow pitch drift is what makes a pad sound like tape. Applied as a
      // whole number of cycles per loop so the drift meets itself at the seam.
      const wowed = new Float32Array(buf.length);
      const depth = 0.0022;
      for (let i = 0; i < buf.length; i++) {
        const phase = (i / buf.length) * Math.PI * 2 * 3;
        const source = i + Math.sin(phase) * depth * SR;
        const base = Math.floor(source);
        const frac = source - base;
        const a = buf[((base % buf.length) + buf.length) % buf.length];
        const b = buf[(((base + 1) % buf.length) + buf.length) % buf.length];
        wowed[i] = a + (b - a) * frac;
      }
      buf.set(wowed);
      duckMids(buf, 380, 3200, 0.55);
      lowpass(buf, 3800);
      return wrapDelay(buf, 1.2, 0.48, 0.55);
    },
  },
];

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function toInt16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

function encodeMp3(samples) {
  const encoder = new lamejs.Mp3Encoder(1, SR, KBPS);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const slice = samples.subarray(i, Math.min(i + block, samples.length));
    const encoded = encoder.encodeBuffer(slice);
    if (encoded.length > 0) chunks.push(Buffer.from(encoded));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

/**
 * Seam check: the largest jump across the loop point should be no worse than the
 * jumps the waveform already makes inside the loop, or the loop will click.
 */
function seamScore(buf) {
  let inside = 0;
  for (let i = 1; i < buf.length; i++) inside = Math.max(inside, Math.abs(buf[i] - buf[i - 1]));
  const across = Math.abs(buf[0] - buf[buf.length - 1]);
  return { across, inside, ok: across <= Math.max(inside, 1e-6) };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const library = [];

  for (const track of TRACKS) {
    const raw = track.build();
    const buf = Float32Array.from(raw);
    master(buf);
    const seam = seamScore(buf);
    const duration = buf.length / SR;
    const mp3 = encodeMp3(toInt16(buf));
    fs.writeFileSync(path.join(OUT_DIR, track.file), mp3);

    library.push({
      id: track.id,
      title: track.title,
      category: track.category,
      src: `/music/${track.file}`,
      duration: Number(duration.toFixed(2)),
      artist: 'GLASKO Library',
      license: 'CC0 1.0 — public domain, synthesised for GLASKO',
      mood: track.mood,
    });

    console.log(
      `${track.id.padEnd(18)} ${track.title.padEnd(14)} ${duration.toFixed(1)}s  ` +
        `peak ${peak(buf).toFixed(3)}  rms ${rms(buf).toFixed(3)}  ` +
        `seam ${seam.ok ? 'ok' : `CLICK ${seam.across.toFixed(4)}`}  ` +
        `${(mp3.length / 1024).toFixed(0)} KB`,
    );
  }

  fs.writeFileSync(path.join(OUT_DIR, 'library.json'), `${JSON.stringify(library, null, 2)}\n`);
  const total = library.reduce((sum, t) => sum + t.duration, 0);
  console.log(`\n${library.length} tracks, ${total.toFixed(0)}s total -> ${OUT_DIR}`);
}

main();
