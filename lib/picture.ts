/**
 * The picture window — the podcast / news inset.
 *
 * Two halves live here: what the user chose (`PictureSettings`, edited by
 * `components/PicturePanel.tsx`) and where that can actually go in the frame
 * (`planPicture`). The second half is the interesting one.
 *
 * The window is never given a position in pixels. It is given a corner and a size,
 * and it finds the largest empty box anchored in that corner, measured against the
 * boxes the other elements have already claimed — the logo row, the headline, the
 * animation stage, the progress rail, the subtitle band, the watermark. That is why
 * the same settings produce a sensible inset at 9:16, 1:1 and 16:9 without three
 * sets of numbers: the shapes differ, so the empty space differs, so the answer
 * differs. Nothing here knows which format it is looking at.
 *
 * It also means the guarantees in the brief are structural rather than checked
 * afterwards. The window cannot cover the logo, the headline, the subtitles, the
 * progress line or the watermark, because every one of those is passed in as a box
 * to keep out of, and the search only ever returns space that no box occupies.
 */

import { type Layout, type Rect } from './layout';

export type PictureShape = 'circle' | 'rounded' | 'square';
export type PictureSize = 'small' | 'medium' | 'large';
export type PicturePosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
/** Where the artwork comes from: its own upload, or the backdrop image reused. */
export type PictureSource = 'upload' | 'background';

export interface PictureSettings {
  enabled: boolean;
  shape: PictureShape;
  size: PictureSize;
  position: PicturePosition;
  source: PictureSource;
}

export const DEFAULT_PICTURE: PictureSettings = {
  enabled: false,
  shape: 'rounded',
  size: 'medium',
  position: 'top-right',
  source: 'upload',
};

export const PICTURE_SHAPES: Array<{ id: PictureShape; label: string }> = [
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded rectangle' },
  { id: 'square', label: 'Square' },
];

export const PICTURE_SIZES: Array<{ id: PictureSize; label: string }> = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
];

export const PICTURE_POSITIONS: Array<{ id: PicturePosition; label: string }> = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-right', label: 'Bottom right' },
];

/**
 * The Smaller / Larger buttons.
 *
 * They step through the three named sizes and stop at each end rather than wrapping,
 * which is what the buttons being disabled at the ends tells the user. There is no
 * fourth size to reach and no free-form scale to land between the steps.
 */
const ORDER: PictureSize[] = ['small', 'medium', 'large'];

export function stepPictureSize(size: PictureSize, direction: -1 | 1): PictureSize {
  const index = ORDER.indexOf(size);
  const next = Math.min(ORDER.length - 1, Math.max(0, index + direction));
  return ORDER[next];
}

export function canStepPicture(size: PictureSize, direction: -1 | 1): boolean {
  return stepPictureSize(size, direction) !== size;
}

/** Corner radius for each shape, as a fraction of the side. */
function radiusFor(shape: PictureShape, side: number): number {
  if (shape === 'circle') return side / 2;
  if (shape === 'rounded') return side * 0.17;
  return 0;
}

export interface PicturePlan extends Rect {
  shape: PictureShape;
  radius: number;
  /**
   * How much of the requested size survived the space available, 0..1.
   *
   * 1 means the chosen size fitted as asked. Less means the corner was tight and the
   * window was trimmed to stay clear of everything else — which is the behaviour the
   * brief asks for, and is worth reporting rather than hiding.
   */
  fit: number;
  /** True when the window could not stay in the corner the user picked. */
  moved: boolean;
  position: PicturePosition;
}

const isTop = (position: PicturePosition) =>
  position === 'top-left' || position === 'top-right';
const isLeft = (position: PicturePosition) =>
  position === 'top-left' || position === 'bottom-left';

/**
 * Corners to try, in order, starting from the one the user picked.
 *
 * The horizontal side is held on to first: a top-right window that will not fit
 * drops to bottom-right before it crosses to the other half of the frame, because
 * which side of the frame a face sits on is the part of the choice that reads.
 */
function fallbackOrder(position: PicturePosition): PicturePosition[] {
  const vertical: PicturePosition = isTop(position)
    ? (isLeft(position) ? 'bottom-left' : 'bottom-right')
    : isLeft(position)
      ? 'top-left'
      : 'top-right';
  const horizontal: PicturePosition = isLeft(position)
    ? (isTop(position) ? 'top-right' : 'bottom-right')
    : isTop(position)
      ? 'top-left'
      : 'bottom-left';
  const diagonal: PicturePosition = isTop(position)
    ? (isLeft(position) ? 'bottom-right' : 'bottom-left')
    : isLeft(position)
      ? 'top-right'
      : 'top-left';
  return [position, vertical, horizontal, diagonal];
}

/**
 * How much a cut is worth keeping, relative to one that leaves the corner intact.
 *
 * Every obstruction can be escaped four ways — take the space to its left, its right,
 * above it or below it — and two of those give up an edge the corner was pinned to.
 * They are not forbidden, only discouraged: a bottom-left window with the watermark in
 * the same corner has to sit above the mark, and refusing to do that would send the
 * window to a different corner entirely, which is a bigger change than the user asked
 * for. Giving up the vertical edge costs less than giving up the horizontal one,
 * because which side of the frame a face sits on is the part of the choice that reads.
 */
const KEEP = 1;
const LOSE_VERTICAL = 0.97;
const LOSE_HORIZONTAL = 0.9;

/**
 * The largest empty box in `bounds`, biased toward one corner.
 *
 * Obstructions are escaped one at a time, largest first, by pulling in whichever
 * single edge leaves the biggest square — a square being what the window needs, so
 * `min(width, height)` is the score. Weighted by the constants above, that one rule is
 * what makes the search find the column beside the waveform in landscape, the band
 * under it in a square, and the gap above the watermark in an occupied corner, without
 * any of those cases being written down here.
 */
function cornerSpace(bounds: Rect, blocked: Rect[], position: PicturePosition): Rect {
  const anchorTop = isTop(position);
  const anchorLeft = isLeft(position);
  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let top = bounds.y;
  let bottom = bounds.y + bounds.height;

  // Largest first: the biggest obstruction decides the shape of what is left, and
  // resolving it first stops a sliver from making that decision.
  const ordered = [...blocked].sort((a, b) => b.width * b.height - a.width * a.height);

  for (const rect of ordered) {
    const rectRight = rect.x + rect.width;
    const rectBottom = rect.y + rect.height;
    // Already clear of this one.
    if (left >= rectRight || right <= rect.x || top >= rectBottom || bottom <= rect.y) continue;

    const width = right - left;
    const height = bottom - top;
    const options = [
      {
        score: Math.min(Math.max(0, rect.x - left), height) * (anchorLeft ? KEEP : LOSE_HORIZONTAL),
        apply: () => {
          right = Math.max(left, rect.x);
        },
      },
      {
        score: Math.min(Math.max(0, right - rectRight), height) * (anchorLeft ? LOSE_HORIZONTAL : KEEP),
        apply: () => {
          left = Math.min(right, rectRight);
        },
      },
      {
        score: Math.min(width, Math.max(0, rect.y - top)) * (anchorTop ? KEEP : LOSE_VERTICAL),
        apply: () => {
          bottom = Math.max(top, rect.y);
        },
      },
      {
        score: Math.min(width, Math.max(0, bottom - rectBottom)) * (anchorTop ? LOSE_VERTICAL : KEEP),
        apply: () => {
          top = Math.min(bottom, rectBottom);
        },
      },
    ];

    let best = options[0];
    for (const option of options) if (option.score > best.score) best = option;
    best.apply();
  }

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Below this share of the requested size the corner counts as unusable and the next
 * one is tried. Above it the window stays where the user put it and is trimmed,
 * because moving a window the user placed is a bigger surprise than a slightly
 * smaller one.
 */
const MIN_FIT = 0.62;

export interface PicturePlanInput {
  layout: Layout;
  settings: PictureSettings;
  /** Boxes the window must stay out of, already padded by whatever clearance they want. */
  blocked: Rect[];
  /** Vertical range the window may use — between the top chrome and the progress rail. */
  band: { top: number; bottom: number };
}

/**
 * Resolve the window's box, or null when the frame has no room for one.
 *
 * Called on every frame by `drawFrame`, so it stays arithmetic on a handful of
 * rectangles — no allocation-heavy search, no state carried between frames. Two
 * calls with the same arguments give the same answer, which is what keeps the
 * preview and the exported file identical.
 */
export function planPicture({
  layout,
  settings,
  blocked,
  band,
}: PicturePlanInput): PicturePlan | null {
  if (!settings.enabled) return null;

  const target = layout.pictureSizes[settings.size];
  const bounds: Rect = {
    x: layout.safe.left,
    y: band.top,
    width: layout.width - layout.safe.right - layout.safe.left,
    height: band.bottom - band.top,
  };
  if (bounds.width <= 0 || bounds.height <= 0) return null;

  let best: { space: Rect; side: number; position: PicturePosition } | null = null;

  for (const candidate of fallbackOrder(settings.position)) {
    const space = cornerSpace(bounds, blocked, candidate);
    const side = Math.min(target, space.width, space.height);
    if (!best || side > best.side) best = { space, side, position: candidate };
    // Good enough in this corner: stop looking, so the user's choice wins whenever
    // it can rather than being beaten by a marginally roomier corner elsewhere.
    if (side >= target * MIN_FIT) break;
  }

  // A window under a quarter of its requested size is not an inset any more, it is a
  // speck. Better to draw nothing and say so in the panel than to put that in a video.
  if (!best || best.side < target * 0.25) return null;

  const side = Math.round(best.side);
  const { space, position } = best;
  const x = isLeft(position) ? space.x : space.x + space.width - side;
  const y = isTop(position) ? space.y : space.y + space.height - side;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: side,
    height: side,
    shape: settings.shape,
    radius: radiusFor(settings.shape, side),
    fit: side / target,
    moved: position !== settings.position,
    position,
  };
}
