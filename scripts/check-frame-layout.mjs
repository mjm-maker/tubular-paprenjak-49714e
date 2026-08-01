/**
 * Frame layout check — `npm run layout:check`.
 *
 * The brief for the picture window and the topic line is a geometric one: in Story,
 * Square and Landscape, the logo, the headline, the picture window, the motion, the
 * progress line, the subtitles and the watermark must not overlap, whatever the user
 * has switched on. That is a property of `planFrame()` in `lib/render.ts`, and this
 * walks it across every combination that can produce a different layout and asserts it,
 * rather than leaving it to be spotted in a preview.
 *
 * The renderer is asked for its plan through `frameBoxes()` — the same function the
 * preview and the encoder go through to place things, so a pass here is a statement
 * about the exported MP4 and not only about a test harness. Nothing is drawn: the
 * 2D context is a stub that answers `measureText` from the font size, which is enough
 * because every planner in the renderer measures and never paints.
 *
 * Boxes are compared with a small tolerance rather than exactly, since two elements
 * that share an edge to the pixel are not an overlap anybody can see.
 *
 * Run with plain node; the `.ts` imports are type-stripped by `ts-resolve.mjs`.
 */

import { layoutFor, VIDEO_FORMATS } from '../lib/layout.ts';
import { PICTURE_POSITIONS, PICTURE_SHAPES, PICTURE_SIZES } from '../lib/picture.ts';
import { frameBoxes } from '../lib/render.ts';
import { HEADLINE_MAX_CHARS } from '../lib/headline.ts';
import { DEFAULT_SUBTITLE_SETTINGS } from '../lib/subtitles.ts';
import { DEFAULT_WATERMARK, WATERMARK_POSITIONS, watermarkFor } from '../lib/watermark.ts';

/** Shared edges are not overlaps. One pixel of a 1080-wide frame is nothing. */
const TOLERANCE = 1;

let checks = 0;
let failures = 0;
const seen = new Map();

/**
 * Group results so the output stays readable: one line per assertion, with the number
 * of layouts behind it, instead of tens of thousands of lines of `ok`.
 */
function assertGroup(label, condition, detail) {
  checks++;
  const entry = seen.get(label) ?? { total: 0, bad: 0, first: '' };
  entry.total++;
  if (!condition) {
    entry.bad++;
    if (!entry.first) entry.first = detail ?? '';
  }
  seen.set(label, entry);
}

function report() {
  for (const [label, entry] of seen) {
    if (entry.bad === 0) {
      console.log(`  ok   ${label} (${entry.total} layouts)`);
    } else {
      failures += entry.bad;
      console.log(`  FAIL ${label} — ${entry.bad} of ${entry.total} layouts — ${entry.first}`);
    }
  }
  seen.clear();
}

/* -------------------------------------------------------------------------- */
/* A 2D context that can only measure                                          */
/* -------------------------------------------------------------------------- */

/**
 * Canvas text metrics without a canvas.
 *
 * Every width the renderer asks for goes through `measureText`, so an approximation of
 * one is enough to exercise the wrapping and the fitting. The per-character widths are
 * deliberately a little generous — a check that measured text narrower than a browser
 * would could pass a layout that overflows on screen.
 */
function stubContext() {
  const ctx = {
    font: '400 10px sans-serif',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    lineWidth: 1,
    measureText(text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 10);
      let width = 0;
      for (const character of String(text)) {
        if (character === ' ') width += size * 0.3;
        else if (/[iIjl.,'!|]/.test(character)) width += size * 0.32;
        else if (/[A-ZА-Я]/.test(character)) width += size * 0.68;
        else width += size * 0.56;
      }
      return { width };
    },
    save() {},
    restore() {},
  };
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* The things a frame can be asked to draw                                     */
/* -------------------------------------------------------------------------- */

/** All three shapes, as the format objects the renderer is handed. */
const FORMATS = VIDEO_FORMATS;
const MOTIONS = ['wave', 'bars', 'pulse', 'none'];

/** A stand-in for the loaded logo. Only its aspect ratio reaches the layout. */
const LOGO = { image: {}, width: 787, height: 140 };
/** Same for the artwork: `planPicture` never looks at the pixels. */
const ARTWORK = {};

const FONTS = { display: 'sans-serif', mono: 'monospace', sans: 'sans-serif' };

const HEADLINES = [
  null,
  { label: 'short', text: 'Sofia at six', animation: 'static' },
  // The longest topic the panel will accept, so the wrap and the shrink both run, and
  // the three treatments that move: static is covered by the short one above.
  ...['fade', 'slide', 'typewriter'].map((animation) => ({
    label: `full ${animation}`,
    text: 'Записът на седмицата — какво остана да се каже след като микрофонът спря'.slice(
      0,
      HEADLINE_MAX_CHARS,
    ),
    animation,
  })),
];

const CUES = [
  {
    id: 'c1',
    start: 0,
    end: 30,
    bg: 'Здравейте и добре дошли в предаването, днес говорим за гласа.',
    en: 'Hello and welcome to the programme, today we are talking about the voice.',
  },
];

/**
 * Every mode, every position, and one style per backdrop kind — the backdrop is the
 * only thing about a style that changes the geometry, and the band is the one that is
 * drawn the full width of the frame.
 */
const BACKDROP_STYLES = ['clean', 'modern', 'bold-social', 'bilingual'];

const SUBTITLES = [
  null,
  ...['bg', 'en', 'both'].flatMap((mode) =>
    ['bottom', 'middle', 'top'].flatMap((position) =>
      BACKDROP_STYLES.map((styleId) => ({
        label: `${mode} ${position} ${styleId}`,
        settings: {
          ...DEFAULT_SUBTITLE_SETTINGS,
          mode,
          position,
          styleId,
          // The largest type the panel offers, which is the tightest fit.
          size: 1.5,
        },
      })),
    ),
  ),
];

const PICTURES = [
  null,
  ...PICTURE_POSITIONS.flatMap((position) =>
    PICTURE_SIZES.map((size) => ({
      label: `${position.id} ${size.id}`,
      settings: { enabled: true, shape: 'rounded', size: size.id, position: position.id, source: 'upload' },
    })),
  ),
];

/**
 * When each frame is sampled. 0.15 s is before a slide or a typewriter has moved at all,
 * which is where the entrance is furthest from its resting place, and 3 s is the settled
 * frame every remaining second looks like.
 */
const TIMES = [0.15, 3];

/* -------------------------------------------------------------------------- */

function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= TOLERANCE || height <= TOLERANCE) return 0;
  return width * height;
}

function describe(rect) {
  return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

const ctx = stubContext();

function checkOne(spec, elapsed, label) {
  const layout = layoutFor(spec.format);
  const boxes = frameBoxes(ctx, spec, elapsed);

  // Every pair, both ways round — the whole point is that no two elements share pixels.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // The band backdrop is the subtitle block's own backdrop.
      if (a.name === 'subtitles' && b.name === 'subtitle-band') continue;
      const area = overlap(a.rect, b.rect);
      assertGroup(
        `${a.name} never overlaps ${b.name}`,
        area === 0,
        `${label} @${elapsed}s — ${a.name} ${describe(a.rect)} vs ${b.name} ${describe(b.rect)}`,
      );
    }
  }

  for (const box of boxes) {
    const { x, y, width, height } = box.rect;
    assertGroup(
      'every box stays inside the frame',
      x >= -TOLERANCE &&
        y >= -TOLERANCE &&
        x + width <= layout.width + TOLERANCE &&
        y + height <= layout.height + TOLERANCE,
      `${label} @${elapsed}s — ${box.name} ${describe(box.rect)} in ${layout.width}x${layout.height}`,
    );
    assertGroup(
      'nothing has a negative or empty box',
      width > 0 && height > 0,
      `${label} @${elapsed}s — ${box.name} ${describe(box.rect)}`,
    );
    if (!box.insideSafeArea) continue;
    assertGroup(
      'placed elements stay inside the safe area',
      x >= layout.safe.left - TOLERANCE &&
        y >= layout.safe.top - TOLERANCE &&
        x + width <= layout.width - layout.safe.right + TOLERANCE &&
        y + height <= layout.height - layout.safe.bottom + TOLERANCE,
      `${label} @${elapsed}s — ${box.name} ${describe(box.rect)} outside safe area`,
    );
  }

  // The mark is not optional, and it is drawn in the frame rather than beside it.
  assertGroup(
    'the watermark is in every frame',
    boxes.some((box) => box.name === 'watermark'),
    label,
  );
}

console.log('GLASKO frame layout');

let layouts = 0;
for (const format of FORMATS) {
  for (const animation of MOTIONS) {
    for (const picture of PICTURES) {
      for (const headline of HEADLINES) {
        for (const subtitles of SUBTITLES) {
          const spec = {
            format,
            background: { kind: 'solid', id: 'ink', label: 'Ink', color: '#0D0F12' },
            backgroundImage: null,
            animation,
            fonts: FONTS,
            logo: LOGO,
            picture: picture ? { settings: picture.settings, image: ARTWORK } : null,
            headline: headline
              ? { enabled: true, text: headline.text, animation: headline.animation }
              : null,
            subtitles: subtitles ? { cues: CUES, settings: subtitles.settings } : null,
            watermark: watermarkFor(DEFAULT_WATERMARK),
          };
          const label = [
            format.id,
            animation,
            picture ? `picture ${picture.label}` : 'no picture',
            headline ? `headline ${headline.label}` : 'no headline',
            subtitles ? `subtitles ${subtitles.label}` : 'no subtitles',
          ].join(' · ');
          for (const elapsed of TIMES) checkOne(spec, elapsed, label);
          layouts++;
        }
      }
    }
  }
}

console.log(`  ${layouts.toLocaleString()} layouts × ${TIMES.length} moments`);
report();

/* -------------------------------------------------------------------------- */
/* The watermark may sit in any corner, and the window has to keep out of it    */
/* -------------------------------------------------------------------------- */

console.log('\nWatermark corners');
seen.clear();
for (const format of FORMATS) {
  for (const corner of WATERMARK_POSITIONS) {
    for (const picture of PICTURES.slice(1)) {
      const spec = {
        format,
        background: { kind: 'solid', id: 'ink', label: 'Ink', color: '#0D0F12' },
        animation: 'wave',
        fonts: FONTS,
        logo: LOGO,
        picture: { settings: picture.settings, image: ARTWORK },
        headline: { enabled: true, text: 'Гласът на седмицата', animation: 'fade' },
        subtitles: { cues: CUES, settings: { ...DEFAULT_SUBTITLE_SETTINGS, mode: 'both' } },
        watermark: watermarkFor({ position: corner.id }),
      };
      checkOne(spec, 3, `${format.id} · watermark ${corner.id} · picture ${picture.label}`);
    }
  }
}
report();

/* -------------------------------------------------------------------------- */
/* Shape and size behaviour                                                    */
/* -------------------------------------------------------------------------- */

console.log('\nPicture window shape and size');
seen.clear();
/** Corners where all three steps came out at different sizes, per format. */
const stepping = new Map();
for (const format of FORMATS) {
  const layout = layoutFor(format);
  for (const shape of PICTURE_SHAPES) {
    for (const position of PICTURE_POSITIONS) {
      const sizes = PICTURE_SIZES.map((size) => {
        const spec = {
          format,
          background: { kind: 'solid', id: 'ink', label: 'Ink', color: '#0D0F12' },
          animation: 'wave',
          fonts: FONTS,
          logo: LOGO,
          picture: {
            settings: { enabled: true, shape: shape.id, size: size.id, position: position.id, source: 'upload' },
            image: ARTWORK,
          },
          headline: null,
          subtitles: null,
          watermark: watermarkFor(DEFAULT_WATERMARK),
        };
        const box = frameBoxes(ctx, spec, 3).find((entry) => entry.name === 'picture');
        return { size: size.id, box };
      });

      const where = `${format.id} · ${shape.id} · ${position.id}`;
      for (const { size, box } of sizes) {
        assertGroup('the window is drawn at every size', Boolean(box), `${where} · ${size}`);
        if (!box) continue;
        // Square by construction, which is what makes the circle round and every crop
        // proportional: the artwork is cover-fitted into this box, never stretched to it.
        assertGroup(
          'the window is square',
          Math.abs(box.rect.width - box.rect.height) <= TOLERANCE,
          `${where} · ${size} · ${describe(box.rect)}`,
        );
      }
      const widths = sizes.map((entry) => entry.box?.rect.width ?? 0);
      // Never backwards: Larger can be held up by a tight corner, but it can never
      // hand back a smaller window than the step below it.
      assertGroup(
        'Larger never returns a smaller window',
        widths[0] <= widths[1] && widths[1] <= widths[2],
        `${where} · ${widths.map(Math.round).join(' ≤ ')}`,
      );
      assertGroup(
        'the largest window is a minority of the frame',
        widths[2] <= Math.min(layout.width, layout.height) * 0.4,
        `${where} · ${Math.round(widths[2])} of ${Math.min(layout.width, layout.height)}`,
      );
      if (widths[0] < widths[1] && widths[1] < widths[2]) {
        stepping.set(format.id, (stepping.get(format.id) ?? 0) + 1);
      }
    }
  }
}
for (const format of FORMATS) {
  const corners = stepping.get(format.id) ?? 0;
  // Somewhere in every format the three steps have to be three different sizes, or
  // the Size control is decoration. Corners hemmed in by the motion and the rule clamp
  // to what fits, which is the documented behaviour and not a failure.
  assertGroup(
    'every format has corners where all three sizes differ',
    corners > 0,
    `${format.id} · ${corners} of ${PICTURE_SHAPES.length * PICTURE_POSITIONS.length}`,
  );
}
report();

/* -------------------------------------------------------------------------- */
/* The headline has to survive the frame it is placed into                      */
/* -------------------------------------------------------------------------- */

console.log('\nHeadline placement');
seen.clear();
for (const format of FORMATS) {
  const layout = layoutFor(format);
  for (const corner of WATERMARK_POSITIONS) {
    for (const picture of PICTURES) {
      for (const headline of HEADLINES.slice(1)) {
        const spec = {
          format,
          background: { kind: 'solid', id: 'ink', label: 'Ink', color: '#0D0F12' },
          animation: 'wave',
          fonts: FONTS,
          logo: LOGO,
          picture: picture ? { settings: picture.settings, image: ARTWORK } : null,
          headline: { enabled: true, text: headline.text, animation: headline.animation },
          subtitles: { cues: CUES, settings: { ...DEFAULT_SUBTITLE_SETTINGS, mode: 'both' } },
          watermark: watermarkFor({ position: corner.id }),
        };
        const where = [
          format.id,
          `watermark ${corner.id}`,
          picture ? `picture ${picture.label}` : 'no picture',
          `headline ${headline.label}`,
        ].join(' · ');
        const box = frameBoxes(ctx, spec, 3).find((entry) => entry.name === 'headline');
        // Yielding is one thing; disappearing is another. Every corner the window and the
        // mark can be put in still leaves a row the topic can be set on.
        assertGroup('the headline is drawn wherever it is switched on', Boolean(box), where);
        if (!box) continue;
        assertGroup(
          'the headline stays in the upper half of the frame',
          box.rect.y + box.rect.height <= layout.height / 2,
          `${where} · ${describe(box.rect)}`,
        );
        // Only asked of the long topics: the panel hugs its text, so a three-word headline
        // is a narrow label by design. A full one filling a sliver would be the failure.
        if (!headline.label.startsWith('full')) continue;
        assertGroup(
          'a long headline gets a column it can be read in',
          box.rect.width >= layout.width * 0.3,
          `${where} · ${describe(box.rect)}`,
        );
      }
    }
  }
}
report();

/* -------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
}
