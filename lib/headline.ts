/**
 * The topic / headline — the line of text along the top of the frame.
 *
 * The wording is the user's; everything about how it arrives is decided here. The
 * four intro treatments are resolved to numbers by `headlineIntro()`, which is a pure
 * function of elapsed time: given a second and a half into the clip it returns the
 * same opacity, the same offset and the same visible characters every time it is
 * asked. That is not a stylistic preference — the export renders frame 45 without
 * having rendered frames 0 to 44, so an intro that depended on what the last frame
 * looked like would play in the preview and not in the file.
 *
 * The headline is written once and read for the whole clip: it fades, slides or types
 * itself in and then stays. Nothing scrolls — a permanent news ticker is explicitly
 * out of scope for this version, and a repeating animation would fight the voice.
 */

export type HeadlineAnimation = 'static' | 'fade' | 'slide' | 'typewriter';

export interface HeadlineSettings {
  enabled: boolean;
  text: string;
  animation: HeadlineAnimation;
}

/**
 * Two lines at the frame's headline size, and no more.
 *
 * The renderer enforces the two lines by shrinking the type; this stops the text
 * getting long enough for shrinking to be the only thing holding it, since a headline
 * set small enough to fit ninety characters is no longer readable on a phone.
 */
export const HEADLINE_MAX_CHARS = 72;

export const DEFAULT_HEADLINE: HeadlineSettings = {
  enabled: false,
  text: '',
  animation: 'fade',
};

export const HEADLINE_ANIMATIONS: Array<{
  id: HeadlineAnimation;
  label: string;
  blurb: string;
}> = [
  { id: 'static', label: 'Static', blurb: 'On screen from the first frame' },
  { id: 'fade', label: 'Fade in', blurb: 'Eases up out of the backdrop' },
  { id: 'slide', label: 'Slide in', blurb: 'Enters from the leading edge' },
  { id: 'typewriter', label: 'Typewriter', blurb: 'Types itself out, letter by letter' },
];

/** Trim to the limit without cutting mid-whitespace runs. */
export function clampHeadline(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, HEADLINE_MAX_CHARS);
}

/** Nothing to draw for an empty or whitespace-only topic, whatever the switch says. */
export function headlineText(settings: HeadlineSettings): string {
  if (!settings.enabled) return '';
  return settings.text.trim();
}

/** Cubic ease-out — the same shape as the interface's `--ease-out-quint`, softened. */
function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export interface HeadlineIntro {
  /** 0..1 multiplier on everything drawn for the headline. */
  opacity: number;
  /**
   * How far back along the leading edge the block still is, as a fraction of the travel
   * the frame can spare: -1 at the start of a slide, 0 once it has arrived, 0 always for
   * the other three treatments.
   *
   * A fraction rather than a distance because the distance is the renderer's to decide —
   * a headline sharing its band with the picture window has no room to slide through, and
   * only the frame knows that.
   */
  offset: number;
  /** The characters visible this frame. Typewriter only; the full text otherwise. */
  text: string;
  /** True while the typewriter is still running, so the caret shows. */
  typing: boolean;
}

/** The intro holds off this long, so it reads as an entrance rather than a jump cut. */
const START = 0.18;
const FADE = 0.62;
const SLIDE = 0.78;
/** Seconds per character, and the longest the whole line may take to type itself. */
const PER_CHAR = 0.052;
const MAX_TYPE = 2.6;

export function headlineIntro(
  animation: HeadlineAnimation,
  text: string,
  elapsed: number,
): HeadlineIntro {
  const since = elapsed - START;

  if (animation === 'static') {
    return { opacity: 1, offset: 0, text, typing: false };
  }

  if (animation === 'fade') {
    return { opacity: easeOut(since / FADE), offset: 0, text, typing: false };
  }

  if (animation === 'slide') {
    const progress = easeOut(since / SLIDE);
    return {
      opacity: Math.min(1, progress * 1.25),
      // A fraction of whatever travel the frame can spare, not a distance: the renderer
      // multiplies it by the room it has, which is nothing when the picture window is
      // sitting against the headline's leading edge.
      offset: -(1 - progress),
      text,
      typing: false,
    };
  }

  const characters = [...text];
  const duration = Math.min(MAX_TYPE, Math.max(0.4, characters.length * PER_CHAR));
  const progress = Math.min(1, Math.max(0, since / duration));
  const shown = Math.round(progress * characters.length);
  return {
    // The panel is up before the first letter lands, or the text appears to push it open.
    opacity: since <= 0 ? easeOut(since / 0.2 + 1) : 1,
    offset: 0,
    text: characters.slice(0, shown).join(''),
    typing: progress < 1,
  };
}
