/**
 * Output formats and the frame geometry that goes with each one.
 *
 * `lib/render.ts` used to hard-code the 1080 x 1920 layout as module constants.
 * Three aspect ratios means those numbers have to come from somewhere, and this is
 * that somewhere: one `Layout` object per format, resolved once per frame.
 *
 * The `story` layout reproduces the original constants exactly, down to the
 * vignette radius. That is deliberate — the vertical video is what GLASKO has
 * always produced, and adding formats must not quietly restyle it.
 */

export type FormatId = 'story' | 'square' | 'landscape';

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
      stageHalfHeight: 150,
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
      stageHalfHeight: 150,
      barGap: 14,
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
    };
  }

  // Story: the original constants, unchanged.
  const margin = 92;
  return {
    format,
    width,
    height,
    margin,
    centreX: width / 2,
    stageY: 900,
    stageHalfHeight: 210,
    barGap: 9,
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
  };
}
