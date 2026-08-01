/**
 * Output formats and the frame geometry that goes with each one.
 *
 * `lib/render.ts` used to hard-code the 1080 x 1920 layout as module constants.
 * Three aspect ratios means those numbers have to come from somewhere, and this is
 * that somewhere: one `Layout` object per format, resolved once per frame.
 *
 * The `story` layout keeps the original 9:16 proportions — margins, rule, rail and
 * type scale — with one deliberate change: the animation stage is shorter and no
 * longer runs the full width, so the waveform reads as one element in the frame
 * rather than as the frame itself. The space that frees up is what the headline and
 * the picture window are placed into, and none of it is hard-coded anywhere else.
 */

export type FormatId = 'story' | 'square' | 'landscape';

/** An axis-aligned box in a format's own coordinate space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when two boxes share any area. Touching edges do not count as overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Grow a box by `amount` on every side — the clearance an element wants around it. */
export function padRect(rect: Rect, amount: number): Rect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export interface VideoFormat {
  id: FormatId;
  label: string;
  /** Aspect ratio as the user thinks of it. */
  ratio: string;
  /** Where this shape actually gets posted. */
  blurb: string;
  width: number;
  height: number;
  /** Tailwind `aspect-[…]` value for the preview frame. */
  aspectClass: string;
}

export const VIDEO_FORMATS: VideoFormat[] = [
  {
    id: 'story',
    label: 'Story / Reel',
    ratio: '9:16',
    blurb: 'Instagram Reels and Stories, TikTok, YouTube Shorts',
    width: 1080,
    height: 1920,
    aspectClass: 'aspect-[9/16]',
  },
  {
    id: 'square',
    label: 'Square',
    ratio: '1:1',
    blurb: 'Instagram and Facebook feed posts',
    width: 1080,
    height: 1080,
    aspectClass: 'aspect-square',
  },
  {
    id: 'landscape',
    label: 'Landscape',
    ratio: '16:9',
    blurb: 'YouTube, X, LinkedIn, Facebook video',
    width: 1920,
    height: 1080,
    aspectClass: 'aspect-video',
  },
];

export const DEFAULT_FORMAT: VideoFormat = VIDEO_FORMATS[0];

export function formatById(id: FormatId): VideoFormat {
  return VIDEO_FORMATS.find((format) => format.id === id) ?? DEFAULT_FORMAT;
}

/** `1080 × 1920 · 9:16` — used in the preview footer and the export copy. */
export function describeFormat(format: VideoFormat): string {
  return `${format.width} × ${format.height} · ${format.ratio}`;
}

export interface Layout {
  format: VideoFormat;
  width: number;
  height: number;
  /** Outer gutter for every element. */
  margin: number;
  centreX: number;
  /** Vertical centre of the waveform / bars. */
  stageY: number;
  stageHalfHeight: number;
  /**
   * Half-width of the animation stage, measured from `centreX`.
   *
   * The waveform and the bars used to run the full width between the margins. They
   * are inset now, which is what leaves a column beside them for a picture window —
   * see `lib/picture.ts`, which finds that column rather than being told about it.
   */
  stageHalfWidth: number;
  /** Gap between frequency bars. */
  barGap: number;
  railY: number;
  timeY: number;
  wordmarkY: number;
  ruleY: number;
  wordmarkSize: number;
  clockSize: number;
  timeSize: number;
  vignetteRadius: number;
  /**
   * Region the platform's own interface is likely to cover: usernames and captions
   * along the bottom of a Reel, the action rail down its right edge. Anything the
   * viewer has to read — subtitles, the watermark — stays inside these insets.
   */
  safe: { top: number; right: number; bottom: number; left: number };
  /** Base subtitle type size before the user's size multiplier. */
  subtitleSize: number;
  /** Widest a subtitle line may be before it wraps. */
  subtitleMaxWidth: number;
  /** Watermark type size for "Made with" / "GLASKO". */
  watermarkSize: number;
  /** Top of the headline block. Below the rule, above everything else. */
  headlineTop: number;
  /** Headline type size before it shrinks to fit. */
  headlineSize: number;
  /**
   * Clearance every overlay keeps from its neighbours.
   *
   * One number per format rather than a constant, because "close but not touching"
   * is a different distance on a 1080-wide frame than on a 1920-wide one.
   */
  gap: number;
  /** Side length a picture window asks for at each size step, before clamping. */
  pictureSizes: { small: number; medium: number; large: number };
}

/**
 * Safe insets per format.
 *
 * The story numbers come from where Instagram, TikTok and Facebook actually put
 * their chrome on a 1080 x 1920 canvas: a header strip at the top, a tall caption
 * and button stack at the bottom, and an action rail on the right. Feed formats
 * (square, landscape) are shown in a scrolling card with nothing overlaid, so
 * their insets are just a comfortable margin.
 */
function safeFor(id: FormatId, margin: number) {
  if (id === 'story') {
    return { top: 240, right: 150, bottom: 340, left: margin };
  }
  return { top: margin, right: margin, bottom: 64, left: margin };
}

export function layoutFor(format: VideoFormat): Layout {
  const { id, width, height } = format;

  if (id === 'square') {
    const margin = 84;
    return {
      format,
      width,
      height,
      margin,
      centreX: width / 2,
      stageY: 560,
      stageHalfHeight: 92,
      stageHalfWidth: 366,
      barGap: 9,
      railY: 800,
      timeY: 866,
      wordmarkY: 150,
      ruleY: 196,
      wordmarkSize: 42,
      clockSize: 22,
      timeSize: 26,
      vignetteRadius: 780,
      safe: safeFor(id, margin),
      subtitleSize: 52,
      subtitleMaxWidth: width - margin * 2,
      watermarkSize: 30,
      headlineTop: 232,
      headlineSize: 52,
      gap: 26,
      // Smaller steps than the other two formats, and deliberately so: a square frame
      // has one band clear of the animation, and these are the sizes that fit inside it.
      // Asking for more would mean every step clamping to the same trimmed window.
      pictureSizes: { small: 132, medium: 154, large: 174 },
    };
  }

  if (id === 'landscape') {
    const margin = 110;
    return {
      format,
      width,
      height,
      margin,
      centreX: width / 2,
      stageY: 546,
      stageHalfHeight: 92,
      stageHalfWidth: 528,
      barGap: 13,
      railY: 792,
      timeY: 858,
      wordmarkY: 150,
      ruleY: 196,
      wordmarkSize: 44,
      clockSize: 24,
      timeSize: 28,
      vignetteRadius: 1180,
      safe: safeFor(id, margin),
      subtitleSize: 50,
      subtitleMaxWidth: Math.round(width * 0.76),
      watermarkSize: 30,
      headlineTop: 228,
      headlineSize: 54,
      gap: 28,
      pictureSizes: { small: 180, medium: 236, large: 292 },
    };
  }

  // Story: the original 9:16 proportions, with the animation stage reduced.
  const margin = 92;
  return {
    format,
    width,
    height,
    margin,
    centreX: width / 2,
    stageY: 880,
    stageHalfHeight: 112,
    stageHalfWidth: 386,
    barGap: 10,
    railY: 1268,
    timeY: 1338,
    wordmarkY: 226,
    ruleY: 276,
    wordmarkSize: 44,
    clockSize: 22,
    timeSize: 28,
    vignetteRadius: 1180,
    safe: safeFor(id, margin),
    subtitleSize: 58,
    subtitleMaxWidth: width - margin * 2,
    watermarkSize: 32,
    headlineTop: 320,
    headlineSize: 62,
    gap: 28,
    pictureSizes: { small: 208, medium: 272, large: 336 },
  };
}
