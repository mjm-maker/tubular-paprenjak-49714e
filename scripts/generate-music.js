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
    id: 'calm-01',
    title: 'Soft Morning',
    category: 'Calm',
    file: 'soft-morning.mp3',
    mood: 'Weightless piano-pad haze, no percussion',
    build() {
      const { buf, bar, rng } = grid(68, 8, 11);
      const progression = [
        ['C3', 'E3', 'G3', 'B3'],
        ['A2', 'C3', 'E3', 'G3'],
        ['F2', 'A2', 'C3', 'E3'],
        ['G2', 'B2', 'D3', 'F3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[Math.floor(i / 2) % 4];
        const t = i * bar;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.94, gain: 0.09, kind: 'reed',
          a: 1.15, d: 0.9, s: 0.72, r: 1.5, detune: 0.0016,
        });
        note(buf, { f: hz(voicing[0]) / 2, t0: t, dur: bar * 0.9, gain: 0.15, kind: 'sine', a: 0.5, d: 0.6, s: 0.6, r: 1.2 });
      }
      // Sparse bell figure, drifting so the loop never feels metronomic.
      const bells = ['G4', 'E4', 'C5', 'B4', 'G4', 'A4', 'E5', 'C5'];
      for (let i = 0; i < bells.length; i++) {
        const t = i * bar + (i % 3) * 0.62 + rng() * 0.1;
        note(buf, { f: hz(bells[i]), t0: t, dur: 0.16, gain: 0.075, kind: 'sine', a: 0.006, d: 0.5, s: 0.16, r: 1.5 });
      }
      lowpass(buf, 5200);
      return wrapDelay(buf, 0.52, 0.42, 0.5);
    },
  },
  {
    id: 'calm-02',
    title: 'Still Water',
    category: 'Calm',
    file: 'still-water.mp3',
    mood: 'Slow swelling pads over a low drone',
    build() {
      const { buf, bar } = grid(60, 6, 23);
      const swells = [
        ['D3', 'F3', 'A3'],
        ['Bb2', 'D3', 'F3'],
        ['G2', 'Bb2', 'D3'],
        ['A2', 'C3', 'E3'],
        ['D3', 'F3', 'A3'],
        ['C3', 'E3', 'G3'],
      ];
      for (let i = 0; i < 6; i++) {
        chord(buf, swells[i], {
          t0: i * bar, dur: bar * 0.9, gain: 0.085, kind: 'reed',
          a: 1.7, d: 1.1, s: 0.66, r: 2.1, detune: 0.002, vib: 0.02, vibRate: 0.4,
        });
      }
      note(buf, { f: hz('D1'), t0: 0, dur: bar * 6 - 0.2, gain: 0.2, kind: 'sine', a: 2.2, d: 1, s: 0.85, r: 2.4 });
      note(buf, { f: hz('A1'), t0: bar * 2, dur: bar * 4 - 0.2, gain: 0.1, kind: 'sine', a: 2.4, d: 1, s: 0.8, r: 2.4 });
      lowpass(buf, 3400);
      return wrapDelay(buf, 0.75, 0.5, 0.55);
    },
  },
  {
    id: 'inspirational-01',
    title: 'First Light',
    category: 'Inspirational',
    file: 'first-light.mp3',
    mood: 'Rising arpeggio, soft kick, wide pad',
    build() {
      const { buf, beat, bar, rng } = grid(92, 8, 31);
      const progression = [
        { pad: ['C3', 'E3', 'G3'], arp: ['C4', 'E4', 'G4', 'B4'] },
        { pad: ['G2', 'B2', 'D3'], arp: ['G3', 'B3', 'D4', 'G4'] },
        { pad: ['A2', 'C3', 'E3'], arp: ['A3', 'C4', 'E4', 'A4'] },
        { pad: ['F2', 'A2', 'C3'], arp: ['F3', 'A3', 'C4', 'F4'] },
      ];
      for (let i = 0; i < 8; i++) {
        const step = progression[i % 4];
        const t = i * bar;
        chord(buf, step.pad, { t0: t, dur: bar * 0.95, gain: 0.075, kind: 'reed', a: 0.5, d: 0.5, s: 0.75, r: 0.8, detune: 0.0018 });
        note(buf, { f: hz(step.pad[0]) / 2, t0: t, dur: beat * 3.4, gain: 0.17, kind: 'tri', a: 0.02, d: 0.35, s: 0.5, r: 0.5 });
        // Eighth-note arpeggio, gently accented on the downbeat of each pair.
        for (let e = 0; e < 8; e++) {
          const pitch = step.arp[e % step.arp.length];
          const up = e < 4 ? 1 : 2;
          note(buf, {
            f: hz(pitch) * (up === 2 && e % 2 === 1 ? 2 : 1),
            t0: t + e * (beat / 2),
            dur: 0.1,
            gain: 0.062 * (e % 2 === 0 ? 1 : 0.7),
            kind: 'warm', a: 0.004, d: 0.22, s: 0.12, r: 0.4,
          });
        }
        kick(buf, t, 0.5);
        kick(buf, t + beat * 2, 0.42);
        for (let h = 0; h < 4; h++) noiseHit(buf, t + beat * h + beat / 2, 0.05, 0.032, rng, 0.85);
      }
      lowpass(buf, 8200);
      return wrapDelay(buf, beat / 2, 0.3, 0.28);
    },
  },
  {
    id: 'inspirational-02',
    title: 'Open Road',
    category: 'Inspirational',
    file: 'open-road.mp3',
    mood: 'Anthemic chord plucks with a steady pulse',
    build() {
      const { buf, beat, bar, rng } = grid(100, 8, 47);
      const progression = [
        ['D3', 'F#3', 'A3'],
        ['A2', 'C#3', 'E3'],
        ['B2', 'D3', 'F#3'],
        ['G2', 'B2', 'D3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        // Four plucked chord hits per bar, softening across the bar.
        for (let b = 0; b < 4; b++) {
          chord(buf, voicing, {
            t0: t + b * beat, dur: 0.2, gain: 0.055 * (b === 0 ? 1.25 : 0.85),
            kind: 'tri', a: 0.005, d: 0.3, s: 0.15, r: 0.55,
          });
        }
        note(buf, { f: hz(voicing[0]) / 2, t0: t, dur: beat * 1.6, gain: 0.19, kind: 'tri', a: 0.015, d: 0.3, s: 0.55, r: 0.4 });
        note(buf, { f: hz(voicing[0]) / 2, t0: t + beat * 2, dur: beat * 1.6, gain: 0.15, kind: 'tri', a: 0.015, d: 0.3, s: 0.5, r: 0.4 });
        chord(buf, voicing.map((n) => n.replace(/\d/, (d) => String(Number(d) + 1))), {
          t0: t, dur: bar * 0.92, gain: 0.045, kind: 'reed', a: 0.6, d: 0.6, s: 0.7, r: 0.9, detune: 0.002,
        });
        for (let b = 0; b < 4; b++) {
          kick(buf, t + b * beat, b % 2 === 0 ? 0.5 : 0.34);
          noiseHit(buf, t + b * beat + beat / 2, 0.055, 0.035, rng, 0.86);
        }
      }
      lowpass(buf, 7600);
      return wrapDelay(buf, beat * 0.75, 0.26, 0.24);
    },
  },
  {
    id: 'cinematic-01',
    title: 'Wide Horizon',
    category: 'Cinematic',
    file: 'wide-horizon.mp3',
    mood: 'Minor pad swells, low drone, distant hits',
    build() {
      const { buf, bar } = grid(76, 8, 59);
      const progression = [
        ['A2', 'C3', 'E3'],
        ['F2', 'A2', 'C3'],
        ['C3', 'E3', 'G3'],
        ['G2', 'B2', 'D3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[Math.floor(i / 2) % 4];
        const t = i * bar;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.95, gain: 0.08, kind: 'reed',
          a: 1.4, d: 0.9, s: 0.7, r: 1.6, detune: 0.0022, vib: 0.03, vibRate: 0.3,
        });
        // High shimmer an octave and a fifth up, very quiet.
        note(buf, { f: hz(voicing[2]) * 3, t0: t, dur: bar * 0.8, gain: 0.022, kind: 'sine', a: 1.6, d: 0.8, s: 0.6, r: 1.8 });
      }
      note(buf, { f: hz('A1'), t0: 0, dur: bar * 8 - 0.2, gain: 0.22, kind: 'sine', a: 2, d: 1.2, s: 0.85, r: 2.2 });
      boom(buf, 0, 0.62);
      boom(buf, bar * 4, 0.5);
      boom(buf, bar * 6, 0.34);
      lowpass(buf, 4200);
      return wrapDelay(buf, 0.66, 0.48, 0.5);
    },
  },
  {
    id: 'cinematic-02',
    title: 'Slow Reveal',
    category: 'Cinematic',
    file: 'slow-reveal.mp3',
    mood: 'Suspended chords opening up across eight bars',
    build() {
      const { buf, bar } = grid(80, 8, 71);
      const progression = [
        ['D3', 'E3', 'A3'],
        ['F3', 'G3', 'C4'],
        ['G2', 'C3', 'D3'],
        ['A2', 'D3', 'E3'],
      ];
      for (let i = 0; i < 8; i++) {
        const voicing = progression[i % 4];
        const t = i * bar;
        // Gain climbs over the loop so the last bars feel like a lift, then the
        // wrap-around delay carries it back into bar one.
        const lift = 0.06 + (i / 7) * 0.045;
        chord(buf, voicing, {
          t0: t, dur: bar * 0.96, gain: lift, kind: 'reed',
          a: 1.1, d: 0.8, s: 0.74, r: 1.4, detune: 0.0024,
        });
        note(buf, { f: hz(voicing[0]) / 2, t0: t, dur: bar * 0.9, gain: 0.17, kind: 'sine', a: 0.7, d: 0.6, s: 0.7, r: 1.2 });
      }
      boom(buf, 0, 0.55);
      boom(buf, bar * 4, 0.62);
      lowpass(buf, 5000);
      return wrapDelay(buf, 0.58, 0.44, 0.46);
    },
  },
  {
    id: 'energetic-01',
    title: 'Pulse Line',
    category: 'Energetic',
    file: 'pulse-line.mp3',
    mood: 'Four-on-the-floor with a pumping bass and stabs',
    build() {
      const { buf, beat, bar, rng } = grid(124, 8, 83);
      const roots = ['F2', 'F2', 'Db2', 'Ab2'];
      const stabs = [
        ['Ab3', 'C4', 'F4'],
        ['Ab3', 'C4', 'F4'],
        ['Ab3', 'Db4', 'F4'],
        ['Ab3', 'C4', 'Eb4'],
      ];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        const root = roots[i % 4];
        const voicing = stabs[i % 4];
        for (let e = 0; e < 8; e++) {
          note(buf, {
            f: hz(root) * (e === 6 ? 2 : 1),
            t0: t + e * (beat / 2),
            dur: beat * 0.28,
            gain: 0.16,
            kind: 'saw', a: 0.004, d: 0.09, s: 0.42, r: 0.1,
          });
        }
        chord(buf, voicing, { t0: t + beat * 1.5, dur: 0.13, gain: 0.05, kind: 'saw', a: 0.004, d: 0.16, s: 0.1, r: 0.24 });
        chord(buf, voicing, { t0: t + beat * 3.25, dur: 0.11, gain: 0.042, kind: 'saw', a: 0.004, d: 0.14, s: 0.1, r: 0.22 });
        for (let b = 0; b < 4; b++) {
          kick(buf, t + b * beat, 0.7);
          noiseHit(buf, t + b * beat + beat / 2, 0.075, b === 3 ? 0.09 : 0.03, rng, 0.9);
        }
        clap(buf, t + beat, 0.075, rng);
        clap(buf, t + beat * 3, 0.075, rng);
      }
      lowpass(buf, 9000);
      return wrapDelay(buf, beat * 0.75, 0.22, 0.2);
    },
  },
  {
    id: 'energetic-02',
    title: 'Neon Run',
    category: 'Energetic',
    file: 'neon-run.mp3',
    mood: 'Driving sixteenth-note arpeggio',
    build() {
      const { buf, beat, bar, rng } = grid(128, 8, 97);
      const shapes = [
        ['A3', 'C4', 'E4', 'A4'],
        ['G3', 'B3', 'D4', 'G4'],
        ['F3', 'A3', 'C4', 'F4'],
        ['E3', 'G3', 'B3', 'E4'],
      ];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        const shape = shapes[i % 4];
        for (let s = 0; s < 16; s++) {
          const pitch = shape[s % 4];
          const octave = s % 8 >= 4 ? 2 : 1;
          note(buf, {
            f: hz(pitch) * octave,
            t0: t + s * (beat / 4),
            dur: beat * 0.16,
            gain: 0.07 * (s % 4 === 0 ? 1.2 : 0.82),
            kind: 'warm', a: 0.003, d: 0.1, s: 0.2, r: 0.16,
          });
        }
        note(buf, { f: hz(shape[0]) / 2, t0: t, dur: beat * 1.8, gain: 0.2, kind: 'saw', a: 0.006, d: 0.2, s: 0.5, r: 0.2 });
        note(buf, { f: hz(shape[0]) / 2, t0: t + beat * 2.5, dur: beat * 1.2, gain: 0.16, kind: 'saw', a: 0.006, d: 0.2, s: 0.45, r: 0.2 });
        for (let b = 0; b < 4; b++) {
          kick(buf, t + b * beat, b === 0 ? 0.72 : 0.6);
          noiseHit(buf, t + b * beat + beat / 2, 0.07, 0.028, rng, 0.9);
          noiseHit(buf, t + b * beat + beat * 0.75, 0.035, 0.02, rng, 0.9);
        }
        clap(buf, t + beat * 2, 0.07, rng);
      }
      lowpass(buf, 9500);
      return wrapDelay(buf, beat * 0.375, 0.24, 0.2);
    },
  },
  {
    id: 'business-01',
    title: 'Clean Slate',
    category: 'Business',
    file: 'clean-slate.mp3',
    mood: 'Bright plucks, light kick, unobtrusive',
    build() {
      const { buf, beat, bar, rng } = grid(108, 8, 109);
      const progression = [
        ['E4', 'G#4', 'B4', 'D#5'],
        ['C#4', 'E4', 'G#4', 'B4'],
        ['A3', 'C#4', 'E4', 'G#4'],
        ['B3', 'D#4', 'F#4', 'A4'],
      ];
      const roots = ['E2', 'C#2', 'A1', 'B1'];
      for (let i = 0; i < 8; i++) {
        const t = i * bar;
        const voicing = progression[i % 4];
        const pattern = [0, 1, 2, 3, 2, 1, 3, 2];
        for (let e = 0; e < 8; e++) {
          note(buf, {
            f: hz(voicing[pattern[e]]),
            t0: t + e * (beat / 2),
            dur: 0.09,
            gain: 0.06 * (e % 4 === 0 ? 1.15 : 0.8),
            kind: 'sine', a: 0.003, d: 0.16, s: 0.1, r: 0.32,
          });
        }
        note(buf, { f: hz(roots[i % 4]), t0: t, dur: beat * 1.7, gain: 0.16, kind: 'tri', a: 0.014, d: 0.28, s: 0.5, r: 0.35 });
        note(buf, { f: hz(roots[i % 4]), t0: t + beat * 2, dur: beat * 1.7, gain: 0.13, kind: 'tri', a: 0.014, d: 0.28, s: 0.45, r: 0.35 });
        chord(buf, [voicing[0], voicing[2]], { t0: t, dur: bar * 0.9, gain: 0.032, kind: 'reed', a: 0.7, d: 0.6, s: 0.7, r: 0.9, detune: 0.002 });
        kick(buf, t, 0.42);
        kick(buf, t + beat * 2, 0.34);
        for (let s = 0; s < 8; s++) noiseHit(buf, t + s * (beat / 2) + beat / 4, 0.03, 0.022, rng, 0.88);
      }
      lowpass(buf, 8600);
      return wrapDelay(buf, beat / 2, 0.24, 0.22);
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
    id: 'ambient-01',
    title: 'Deep Field',
    category: 'Ambient',
    file: 'deep-field.mp3',
    mood: 'Slowly beating drones, no pulse at all',
    build() {
      // No tempo — a plain 24 second bed.
      const seconds = 24;
      const buf = new Float32Array(Math.round(seconds * SR));
      const rng = mulberry32(151);
      // Two near-unison pairs a fifth apart: the slight detune makes the pad
      // breathe on its own, which is what keeps a static drone interesting.
      for (const [pitch, gain, det] of [['D2', 0.2, 0.0012], ['A2', 0.14, 0.0016], ['D3', 0.1, 0.002], ['F3', 0.075, 0.0024]]) {
        drone(buf, { f: hz(pitch), gain, kind: 'reed', detune: det, tremolo: 0.22, tremoloCycles: 2 });
      }
      const pings = ['A4', 'D5', 'F4', 'A4', 'C5'];
      for (let i = 0; i < pings.length; i++) {
        note(buf, {
          f: hz(pings[i]), t0: 2.4 + i * 4.3 + rng() * 0.5, dur: 0.12,
          gain: 0.05, kind: 'sine', a: 0.008, d: 0.6, s: 0.12, r: 2.2,
        });
      }
      lowpass(buf, 3000);
      return wrapDelay(buf, 1.1, 0.52, 0.6);
    },
  },
  {
    id: 'ambient-02',
    title: 'Night Air',
    category: 'Ambient',
    file: 'night-air.mp3',
    mood: 'Sparse high pings over a soft low bed',
    build() {
      const seconds = 24;
      const buf = new Float32Array(Math.round(seconds * SR));
      const rng = mulberry32(163);
      for (const [pitch, gain, tremolo, cycles] of [
        ['E2', 0.17, 0.18, 1],
        ['B2', 0.1, 0.3, 3],
        ['G3', 0.07, 0.4, 2],
      ]) {
        drone(buf, { f: hz(pitch), gain, kind: 'reed', detune: 0.0018, tremolo, tremoloCycles: cycles });
      }
      const pings = ['B4', 'E5', 'G4', 'F#5', 'B4', 'D5', 'E5'];
      for (let i = 0; i < pings.length; i++) {
        note(buf, {
          f: hz(pings[i]), t0: 1.2 + i * 3.1 + rng() * 0.7, dur: 0.1,
          gain: 0.055 + rng() * 0.015, kind: 'sine', a: 0.006, d: 0.45, s: 0.1, r: 2.4,
        });
      }
      // Barely-there air, well under the pad.
      for (let i = 0; i < buf.length; i++) buf[i] += (rng() * 2 - 1) * 0.004;
      lowpass(buf, 3600);
      return wrapDelay(buf, 0.9, 0.5, 0.58);
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
