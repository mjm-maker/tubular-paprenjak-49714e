/**
 * Canvas compositor for a single video frame.
 *
 * Drawing always happens in the chosen format's own coordinate space (1080x1920,
 * 1080x1080 or 1920x1080) and is scaled by a transform, so the on-screen preview
 * and the exported MP4 are the same picture at different resolutions — there is
 * only one renderer to keep in sync. Geometry comes from `lib/layout.ts`; nothing
 * in here hard-codes a frame size.
 *
 * Everything the viewer sees is painted here, subtitles and watermark included.
 * Anything drawn outside this function would appear in the preview and not the
 * file, or the other way round, which is exactly the failure the app is built to
 * avoid.
 */

import { BAND_COUNT, type FrameData } from './analysis';
import {
  headlineIntro,
  headlineText,
  type HeadlineIntro,
  type HeadlineSettings,
} from './headline';
import {
  DEFAULT_FORMAT,
  type Layout,
  layoutFor,
  padRect,
  type Rect,
  type VideoFormat,
} from './layout';
import { type BrandLogo, tintedBrandLogo } from './logo';
import { planPicture, type PicturePlan, type PictureSettings } from './picture';
import {
  cueAt,
  cueText,
  languagesFor,
  resolveSubtitleStyle,
  type ResolvedSubtitleStyle,
  type SubtitleCue,
  type SubtitleLanguage,
  type SubtitlePosition,
  type SubtitleSettings,
} from './subtitles';
import { type AnimationKind, type BackgroundChoice, type RenderTheme, rgba, themeFor } from './theme';
import { WATERMARK_NAME, WATERMARK_PREFIX, type ResolvedWatermark } from './watermark';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderSpec {
  format: VideoFormat;
  background: BackgroundChoice;
  /** Loaded bitmap for an uploaded image background. */
  backgroundImage?: CanvasImageSource | null;
  /** `none` means no animation layer is painted at all — see `drawFrame`. */
  animation: AnimationKind;
  /** `sans` carries Cyrillic and is what subtitles and the watermark are set in. */
  fonts: { display: string; mono: string; sans: string };
  /**
   * The GLASKO logo, once `loadBrandLogo()` has it. Absent — still loading, blocked,
   * or no DOM at all — and the frame falls back to the drawn wordmark, so the picture
   * is never missing a brand mark.
   */
  logo?: BrandLogo | null;
  subtitles?: { cues: SubtitleCue[]; settings: SubtitleSettings } | null;
  /**
   * The picture window. The artwork is resolved by the page — an upload of its own, or
   * the backdrop image reused — and arrives here already decoded, because drawing is
   * synchronous. Settings without an image draw nothing at all rather than a
   * placeholder box: an empty frame in the export is worse than no inset.
   */
  picture?: { settings: PictureSettings; image: CanvasImageSource | null } | null;
  /** The topic line along the top of the frame. */
  headline?: HeadlineSettings | null;
  /**
   * Always the output of `watermarkFor()` — the one place `enabled` is decided. In the
   * free version that means the mark is on, so the guard below is for a future paid
   * plan, not for a user setting.
   */
  watermark?: ResolvedWatermark;
}


// --- helpers --------------------------------------------------------------

function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  // Manual fallback for engines without roundRect.
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

type Align = 'left' | 'center' | 'right';

function trackedWidth(ctx: Ctx2D, text: string, tracking: number): number {
  const chars = [...text];
  let total = tracking * Math.max(0, chars.length - 1);
  for (const char of chars) total += ctx.measureText(char).width;
  return total;
}

/**
 * Draw text with explicit letter spacing (`ctx.letterSpacing` is not universal),
 * optionally stroked first so the outline sits behind the fill.
 */
function drawTracked(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: Align = 'left',
  stroke?: { width: number; color: string },
): void {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + tracking * Math.max(0, chars.length - 1);
  let start = x;
  if (align === 'right') start = x - total;
  else if (align === 'center') start = x - total / 2;

  ctx.textAlign = 'left';
  if (stroke && stroke.width > 0) {
    ctx.save();
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    let cursor = start;
    for (let i = 0; i < chars.length; i++) {
      ctx.strokeText(chars[i], cursor, y);
      cursor += widths[i] + tracking;
    }
    ctx.restore();
  }
  let cursor = start;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cursor, y);
    cursor += widths[i] + tracking;
  }
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

let grainTile: HTMLCanvasElement | OffscreenCanvas | null = null;

/** A small tileable noise texture, generated once and reused for every frame. */
function getGrainTile(): HTMLCanvasElement | OffscreenCanvas | null {
  if (grainTile) return grainTile;
  const size = 128;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(size, size);
  } else if (typeof document !== 'undefined') {
    const element = document.createElement('canvas');
    element.width = size;
    element.height = size;
    canvas = element;
  } else {
    return null;
  }
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) return null;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 120 + Math.random() * 135;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  grainTile = canvas;
  return grainTile;
}

// --- layers ---------------------------------------------------------------

function paintBackground(ctx: Ctx2D, layout: Layout, spec: RenderSpec, theme: RenderTheme): void {
  const { background, backgroundImage } = spec;
  const { width, height, centreX, stageY } = layout;

  if (background.kind === 'image' && backgroundImage) {
    const size = imageSize(backgroundImage);
    if (size) {
      // Cover-fit, centred.
      const scale = Math.max(width / size.width, height / size.height);
      const w = size.width * scale;
      const h = size.height * scale;
      ctx.drawImage(backgroundImage, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#0D0F12';
      ctx.fillRect(0, 0, width, height);
    }

    // Scrim: keeps the wordmark, timings and animation readable over any photo.
    const scrim = ctx.createLinearGradient(0, 0, 0, height);
    scrim.addColorStop(0, 'rgba(8, 10, 13, 0.72)');
    scrim.addColorStop(0.34, 'rgba(8, 10, 13, 0.36)');
    scrim.addColorStop(0.62, 'rgba(8, 10, 13, 0.42)');
    scrim.addColorStop(1, 'rgba(8, 10, 13, 0.78)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (background.kind === 'gradient') {
    const radians = (background.angle * Math.PI) / 180;
    const halfDiagonal = Math.hypot(width, height) / 2;
    const dx = Math.cos(radians) * halfDiagonal;
    const dy = Math.sin(radians) * halfDiagonal;
    const gradient = ctx.createLinearGradient(
      centreX - dx,
      height / 2 - dy,
      centreX + dx,
      height / 2 + dy,
    );
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = background.kind === 'solid' ? background.color : '#0D0F12';
  }
  ctx.fillRect(0, 0, width, height);

  // Vignette adds depth so flat colours do not read as a blank slide.
  const vignette = ctx.createRadialGradient(
    centreX,
    stageY - 60,
    120,
    centreX,
    stageY - 60,
    layout.vignetteRadius,
  );
  vignette.addColorStop(0, rgba('#FFFFFF', theme.light ? 0.22 : 0.07));
  vignette.addColorStop(1, rgba('#000000', theme.light ? 0.1 : 0.28));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function imageSize(source: CanvasImageSource): { width: number; height: number } | null {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return { width: source.width, height: source.height };
  }
  const candidate = source as { width?: number; height?: number };
  if (typeof candidate.width === 'number' && typeof candidate.height === 'number') {
    return { width: candidate.width, height: candidate.height };
  }
  return null;
}

const patternCache = new WeakMap<object, CanvasPattern>();

function paintGrain(ctx: Ctx2D, layout: Layout, frameIndex: number): void {
  let pattern = patternCache.get(ctx);
  if (!pattern) {
    const tile = getGrainTile();
    if (!tile) return;
    const created = ctx.createPattern(tile, 'repeat');
    if (!created) return;
    // Building the pattern once per context matters: this runs 30 times a second
    // during export and on every preview frame.
    patternCache.set(ctx, created);
    pattern = created;
  }

  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = 'overlay';
  // Shift the tile every frame so the grain shimmers like film rather than
  // sitting there as a static dirty-lens texture.
  const offsetX = (frameIndex * 37) % 128;
  const offsetY = (frameIndex * 61) % 128;
  ctx.translate(-offsetX, -offsetY);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, layout.width + 128, layout.height + 128);
  ctx.restore();
}

/**
 * Points the waveform is drawn through.
 *
 * `lib/analysis.ts` hands over a 529-sample window, which is far more detail than a
 * stage a few hundred units wide can show: drawn one sample per pixel it reads as
 * noise rather than as speech. Each bucket keeps its peak, so nothing quiet is
 * invented and nothing loud is lost.
 */
const WAVE_POINTS = 72;

/** Bars actually drawn, aggregated from the 40 analysis bands. */
const BAR_COUNT = 24;

/** The pulse's tallest excursion, as a share of the stage the other two modes use. */
const PULSE_SCALE = 0.3;

/**
 * How visible the pulse is. The brief asks for roughly 30%, and it is applied once as
 * a `globalAlpha` over the whole line rather than folded into each colour, so the line
 * cannot end up darker where it overlaps itself.
 */
const PULSE_OPACITY = 0.3;

function pulseHalfHeight(layout: Layout): number {
  return layout.stageHalfHeight * PULSE_SCALE;
}

/**
 * Reduce the sample window to `points` peaks, then take one 1-2-1 pass over them.
 *
 * The smoothing is along the frame, never between frames: the export renders frame 45
 * without having rendered 44, so anything remembered from the previous frame would
 * move in the preview and sit still in the file.
 */
function resampleWave(wave: ArrayLike<number>, points: number): number[] {
  const peaks = new Array<number>(points).fill(0);
  const size = wave.length / points;
  for (let i = 0; i < points; i++) {
    const start = Math.floor(i * size);
    const end = Math.max(start + 1, Math.floor((i + 1) * size));
    let peak = 0;
    for (let j = start; j < end && j < wave.length; j++) peak = Math.max(peak, wave[j]);
    peaks[i] = peak;
  }
  const smoothed = peaks.slice();
  for (let i = 1; i < points - 1; i++) {
    smoothed[i] = (peaks[i - 1] + peaks[i] * 2 + peaks[i + 1]) / 4;
  }
  return smoothed;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Trace a polyline as a curve: every vertex becomes a control point and the curve
 * passes through the midpoints between them.
 *
 * Cheap, and — unlike a spline fitted per frame — free of overshoot, so a loud syllable
 * cannot make the outline bulge past its own peak. Assumes the path is already open at
 * the first point.
 */
function traceThrough(ctx: Ctx2D, points: Point[]): void {
  if (points.length === 0) return;
  ctx.lineTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

/**
 * The closed, vertically mirrored outline both the waveform and the pulse are drawn
 * from — one shape, two amplitudes.
 */
function waveOutline(
  ctx: Ctx2D,
  layout: Layout,
  levels: number[],
  half: number,
  minAmplitude: number,
): void {
  const { centreX, stageY, stageHalfWidth } = layout;
  const left = centreX - stageHalfWidth;
  const step = (stageHalfWidth * 2) / Math.max(1, levels.length - 1);

  const top: Point[] = levels.map((level, i) => ({
    x: left + i * step,
    y: stageY - Math.max(minAmplitude, level * half),
  }));
  const bottom: Point[] = [];
  for (let i = top.length - 1; i >= 0; i--) {
    bottom.push({ x: top[i].x, y: stageY * 2 - top[i].y });
  }

  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  traceThrough(ctx, top);
  traceThrough(ctx, bottom);
  ctx.closePath();
}

function paintWave(ctx: Ctx2D, layout: Layout, frame: FrameData, theme: RenderTheme): void {
  const { centreX, stageY, stageHalfHeight, stageHalfWidth } = layout;
  const left = centreX - stageHalfWidth;
  const levels = resampleWave(frame.wave, WAVE_POINTS);
  const minAmplitude = Math.max(2.5, stageHalfHeight * 0.03);
  const buildPath = () => waveOutline(ctx, layout, levels, stageHalfHeight, minAmplitude);

  // Upcoming audio: quiet.
  ctx.save();
  buildPath();
  ctx.fillStyle = rgba(theme.fg, 0.26);
  ctx.fill();
  ctx.restore();

  // Already-played audio: accent, clipped to the left of the playhead.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, stageY - stageHalfHeight - 20, centreX - left, stageHalfHeight * 2 + 40);
  ctx.clip();
  buildPath();
  ctx.fillStyle = rgba(theme.accent, 0.92);
  ctx.fill();
  ctx.restore();

  // Playhead. Thinner than the wave is tall on purpose: it marks the position, and a
  // heavy bar through a smaller stage reads as a second element.
  const capY = stageY - stageHalfHeight - 22;
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.9);
  roundedRect(ctx, centreX - 1.5, capY, 3, stageHalfHeight * 2 + 34, 1.5);
  ctx.fill();
  const dotRadius = 6 + frame.level * 5;
  ctx.beginPath();
  ctx.arc(centreX, capY, dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.accent, 0.95);
  ctx.fill();
  ctx.restore();
}

function paintBars(ctx: Ctx2D, layout: Layout, frame: FrameData, theme: RenderTheme): void {
  const { centreX, stageY, stageHalfHeight, stageHalfWidth, barGap: gap } = layout;
  const usable = stageHalfWidth * 2;
  const left = centreX - stageHalfWidth;
  const barWidth = (usable - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const radius = barWidth / 2;
  const minHeight = barWidth * 0.85;
  const perBar = BAND_COUNT / BAR_COUNT;

  const gradient = ctx.createLinearGradient(
    0,
    stageY - stageHalfHeight,
    0,
    stageY + stageHalfHeight,
  );
  gradient.addColorStop(0, rgba(theme.accent, 0.95));
  gradient.addColorStop(0.5, rgba(theme.fg, 0.95));
  gradient.addColorStop(1, rgba(theme.accent, 0.95));

  ctx.save();
  ctx.fillStyle = gradient;
  for (let b = 0; b < BAR_COUNT; b++) {
    // Average the analysis bands that land in this bar rather than dropping the ones
    // with no bar of their own. A mean moves with the whole group, which is what makes
    // the row read as smooth without carrying any state between frames.
    const start = Math.floor(b * perBar);
    const end = Math.max(start + 1, Math.floor((b + 1) * perBar));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end && i < BAND_COUNT; i++) {
      sum += frame.bands[i] ?? 0;
      count += 1;
    }
    const magnitude = count > 0 ? sum / count : 0;
    const half = Math.max(minHeight / 2, magnitude * stageHalfHeight);
    const x = left + b * (barWidth + gap);
    roundedRect(ctx, x, stageY - half, barWidth, half * 2, radius);
    ctx.fill();
  }
  ctx.restore();

  // Centre hairline ties the bars together and marks silence.
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.2);
  ctx.fillRect(left, stageY - 1, usable, 2);
  ctx.restore();
}

/**
 * Minimal pulse: one thin line, low, soft and held at about a third of the opacity the
 * other two modes carry.
 *
 * It is the same outline as the waveform at a fraction of the amplitude, with no
 * playhead, no played/unplayed split and no second colour — every one of those is
 * another thing in the frame, and the point of this mode is that there is almost
 * nothing in the frame. Filling and stroking the one path is what rounds the peaks:
 * the stroke's round joins sit over the fill's corners.
 */
function paintPulse(ctx: Ctx2D, layout: Layout, frame: FrameData, theme: RenderTheme): void {
  const half = pulseHalfHeight(layout);
  const levels = resampleWave(frame.wave, WAVE_POINTS);
  const thickness = Math.max(2.5, half * 0.14);

  ctx.save();
  ctx.globalAlpha = PULSE_OPACITY;
  waveOutline(ctx, layout, levels, half, thickness);
  ctx.fillStyle = rgba(theme.fg, 0.95);
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = thickness;
  ctx.strokeStyle = rgba(theme.fg, 0.95);
  ctx.stroke();
  ctx.restore();
}

/**
 * The logo's slot in the frame: exactly the one the drawn wordmark occupied.
 *
 * Height is tied to `wordmarkSize`, so the mark scales with each format's type
 * instead of carrying pixel values that only suit 9:16 — the logo's lettering lands
 * at the cap height the text had, and its waveform glyph in the space the three bars
 * used. Width follows from the file's own aspect ratio, never the other way round, so
 * the logo can only ever be scaled, never stretched. The box is centred on the old
 * cap height rather than sat on its baseline, which keeps the lettering optically
 * where it was while leaving room for the waveform's tail below it.
 *
 * The width cap is a guard rather than a limit anything hits today: it keeps the mark
 * clear of the duration clock on the far side of the same row, whatever a future
 * format's margins are.
 */
function logoBox(
  layout: Layout,
  logo: BrandLogo,
): { x: number; y: number; width: number; height: number } {
  const aspect = logo.width / logo.height;
  const maxWidth = (layout.width - layout.margin * 2) * 0.42;
  const width = Math.min(layout.wordmarkSize * 1.2 * aspect, maxWidth);
  const height = width / aspect;
  const capCentre = layout.wordmarkY - layout.wordmarkSize * 0.36;
  return { x: layout.margin, y: capCentre - height / 2, width, height };
}

/**
 * Wordmark, rule, progress rail and timings.
 *
 * `chromeShift` moves the rail and the timings vertically. Subtitles are placed
 * first and can need the space, so rather than letting the two collide the chrome
 * yields — see `planSubtitles`.
 */
function paintChrome(
  ctx: Ctx2D,
  layout: Layout,
  frame: FrameData,
  spec: RenderSpec,
  theme: RenderTheme,
  chromeShift: number,
): void {
  const { margin, width, wordmarkY, ruleY, wordmarkSize } = layout;
  const railY = layout.railY + chromeShift;
  const timeY = layout.timeY + chromeShift;

  ctx.save();
  if (spec.logo) {
    // The logo file. Its own colours are warm bone and gold, made for a dark frame,
    // so a light background gets the single-colour silhouette instead — same shape,
    // theme ink, exactly the adaptation the text wordmark made before it.
    const box = logoBox(layout, spec.logo);
    const art = theme.light ? tintedBrandLogo(spec.logo, theme.fg) : spec.logo.image;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.95;
    ctx.drawImage(art, box.x, box.y, box.width, box.height);
    ctx.globalAlpha = 1;
  } else {
    // Fallback while the logo loads, or if it never does: the drawn mark — three
    // ascending bars, then the wordmark.
    ctx.fillStyle = rgba(theme.accent, 0.95);
    const markHeights = [22, 38, 28];
    markHeights.forEach((height, index) => {
      roundedRect(ctx, margin + index * 13, wordmarkY - height, 7, height, 3.5);
      ctx.fill();
    });

    ctx.fillStyle = rgba(theme.fg, 0.9);
    ctx.font = `500 ${wordmarkSize}px ${spec.fonts.display}`;
    ctx.textBaseline = 'alphabetic';
    drawTracked(ctx, 'GLASKO', margin + 60, wordmarkY, 7);
  }

  ctx.font = `500 ${layout.clockSize}px ${spec.fonts.mono}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(theme.fg, 0.45);
  drawTracked(ctx, formatClock(frame.duration), width - margin, wordmarkY - 4, 3, 'right');

  ctx.fillStyle = rgba(theme.fg, 0.16);
  ctx.fillRect(margin, ruleY, width - margin * 2, 2);
  ctx.restore();

  // Progress rail.
  const railWidth = width - margin * 2;
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.16);
  roundedRect(ctx, margin, railY, railWidth, 6, 3);
  ctx.fill();
  const played = railWidth * Math.min(1, Math.max(0, frame.progress));
  ctx.fillStyle = rgba(theme.accent, 0.95);
  roundedRect(ctx, margin, railY, Math.max(6, played), 6, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(margin + played, railY + 3, 11, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.fg, 0.95);
  ctx.fill();
  ctx.restore();

  // Timings.
  ctx.save();
  ctx.font = `500 ${layout.timeSize}px ${spec.fonts.mono}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(theme.fg, 0.62);
  drawTracked(ctx, formatClock(frame.elapsed), margin, timeY, 2);
  ctx.fillStyle = rgba(theme.fg, 0.34);
  drawTracked(
    ctx,
    '-' + formatClock(Math.max(0, frame.duration - frame.elapsed)),
    width - margin,
    timeY,
    2,
    'right',
  );
  ctx.restore();
}

// --- reserved space -------------------------------------------------------

/**
 * The boxes the overlays have to work around.
 *
 * Every element that cannot move — the logo row, the animation, the watermark — is
 * measured as a rectangle, and the two that can move are placed into what is left: the
 * picture window first, then the headline in the column beside it, then subtitles
 * carved against both. Fixing that order is what makes "nothing overlaps" a property
 * of the layout rather than something to check afterwards, in all three formats.
 */

/** The top row: logo (or the drawn wordmark), the duration clock and the rule. */
function topChromeRect(layout: Layout, spec: RenderSpec): Rect {
  const markTop = layout.wordmarkY - layout.wordmarkSize;
  const top = Math.min(spec.logo ? logoBox(layout, spec.logo).y : markTop, markTop) - 10;
  return { x: 0, y: top, width: layout.width, height: layout.ruleY + 12 - top };
}

/**
 * What the animation occupies, or null for `none` — in which case the space is genuinely
 * free and the picture window is welcome to all of it.
 *
 * Taller above than below for the waveform, because the playhead's cap and its dot sit
 * over the top of the stage and nothing sits under it.
 */
function stageRect(layout: Layout, spec: RenderSpec): Rect | null {
  if (spec.animation === 'none') return null;
  const half = spec.animation === 'pulse' ? pulseHalfHeight(layout) : layout.stageHalfHeight;
  const above = spec.animation === 'wave' ? half + 34 : half + 8;
  const below = half + 8;
  return {
    x: layout.centreX - layout.stageHalfWidth,
    y: layout.stageY - above,
    width: layout.stageHalfWidth * 2,
    height: above + below,
  };
}

// --- picture window -------------------------------------------------------

/**
 * The podcast inset: artwork, cropped to its shape, with a border and a soft shadow.
 *
 * Cover-fit, so the image is scaled to fill the square and centred — the crop takes the
 * overflow rather than the aspect ratio being bent to fit, which is why a portrait
 * photo comes out as a portrait photo with its sides trimmed and never as a stretched
 * one. The shape is a clip path, so the circle is a true circle and the rounded corners
 * are curves rather than a mask drawn over the top.
 */
function paintPicture(
  ctx: Ctx2D,
  spec: RenderSpec,
  theme: RenderTheme,
  plan: PicturePlan,
  image: CanvasImageSource,
): void {
  const { x, y, width, height, radius } = plan;

  // Shadow first, on a plate of its own: cast off the artwork it would be re-cast on
  // every stroke, and cast off the clip path it would not appear at all.
  ctx.save();
  ctx.shadowColor = 'rgba(4, 6, 9, 0.42)';
  ctx.shadowBlur = width * 0.11;
  ctx.shadowOffsetY = width * 0.035;
  ctx.fillStyle = theme.light ? 'rgba(20, 24, 29, 0.24)' : 'rgba(4, 6, 9, 0.5)';
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRect(ctx, x, y, width, height, radius);
  ctx.clip();
  const size = imageSize(image);
  if (size && size.width > 0 && size.height > 0) {
    const scale = Math.max(width / size.width, height / size.height);
    const w = size.width * scale;
    const h = size.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
  } else {
    // An image whose size cannot be read is not drawn as a hole in the frame.
    ctx.fillStyle = rgba(theme.fg, 0.12);
    ctx.fillRect(x, y, width, height);
  }
  ctx.restore();

  // Border, inside the shape so the stroke is not half-clipped away.
  const strokeWidth = Math.max(2, width * 0.012);
  ctx.save();
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = rgba(theme.light ? '#0D0F12' : '#F6F1E7', theme.light ? 0.34 : 0.42);
  roundedRect(
    ctx,
    x + strokeWidth / 2,
    y + strokeWidth / 2,
    width - strokeWidth,
    height - strokeWidth,
    Math.max(0, radius - strokeWidth / 2),
  );
  ctx.stroke();
  ctx.restore();
}

// --- headline -------------------------------------------------------------

interface HeadlinePlan {
  /** Every line of the full text, wrapped. The typewriter reveals characters of these. */
  lines: string[];
  fontSize: number;
  lineHeight: number;
  intro: HeadlineIntro;
  x: number;
  width: number;
  top: number;
  bottom: number;
  padX: number;
  padY: number;
  accentWidth: number;
  /**
   * How far left of `x` a Slide In entrance may start, in frame units.
   *
   * Zero when the picture window is against the headline's leading edge: the block would
   * have to travel across the artwork to arrive, so it arrives without travelling and the
   * entrance reads as the fade the opacity ramp is already doing. Nothing about the frame
   * is allowed to move over the window.
   */
  slide: number;
}

/** A row the headline could be set on: a top edge and the column free at that height. */
interface HeadlineBand {
  top: number;
  left: number;
  right: number;
}

/** The text set into `column`, shrinking until it takes two lines or the attempts run out. */
function fitHeadline(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
  text: string,
  column: number,
): { fontSize: number; lines: string[]; fits: boolean } {
  let fontSize = layout.headlineSize;
  let lines: string[] = [];
  let fits = false;
  for (let attempt = 0; attempt < 7; attempt++) {
    fontSize = layout.headlineSize * Math.pow(0.9, attempt);
    ctx.font = `600 ${fontSize}px ${spec.fonts.sans}`;
    const wrapped = wrapText(ctx, text, column - fontSize * 0.46 * 2, 0);
    lines = wrapped.slice(0, 2);
    // One or two lines, never three: the rest of the frame is budgeted around that.
    if (wrapped.length <= 2) {
      fits = true;
      break;
    }
  }
  return { fontSize, lines, fits };
}

/**
 * The rows the headline may be set on, topmost first.
 *
 * The first is always the format's own headline row, narrowed to whatever column the
 * blocking boxes leave at that height. After that comes one row under each box that was
 * in the way — a top-corner picture window or watermark takes the row it sits on, and the
 * headline reads better on the full width below it than squeezed into the strip beside it.
 */
function headlineBands(layout: Layout, blocked: Rect[], maxHeight: number): HeadlineBand[] {
  const tops = [layout.headlineTop];
  for (const rect of blocked) {
    const bottom = rect.y + rect.height;
    if (bottom > layout.headlineTop && !tops.some((top) => Math.abs(top - bottom) < 1)) {
      tops.push(bottom);
    }
  }
  tops.sort((a, b) => a - b);

  return tops.map((top) => {
    let left = layout.safe.left;
    let right = layout.width - layout.safe.right;
    for (const rect of blocked) {
      if (rect.y >= top + maxHeight || rect.y + rect.height <= top) continue;
      if (rect.x + rect.width / 2 < layout.centreX) {
        left = Math.max(left, rect.x + rect.width);
      } else {
        right = Math.min(right, rect.x);
      }
    }
    return { top, left, right };
  });
}

/**
 * Measure the headline block.
 *
 * Measured from the **whole** text, always, even when the typewriter has only revealed
 * three characters of it: a panel that grew as the letters arrived would push the frame
 * around for the first two seconds of every video. The line breaks are therefore also
 * decided once, and the reveal walks through them.
 *
 * The picture window and the watermark are placed first and this yields to both: it takes
 * the topmost row where the whole topic still sets in two lines, dropping below a box in
 * its way rather than beside it when the strip beside it is too narrow to read. It is the
 * element that can reflow, so it is the one that moves. `ceiling` is the lowest its panel
 * may reach — the animation stage, or the progress rail when there is no stage — and a
 * topic with nowhere left above that is left off the frame rather than drawn over
 * something.
 */
function planHeadline(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
  elapsed: number,
  blocked: Rect[],
  ceiling: number,
): HeadlinePlan | null {
  const settings = spec.headline;
  if (!settings) return null;
  const text = headlineText(settings);
  if (!text) return null;

  // The tallest the block could possibly be — two lines at full size, plus padding.
  // Used only to ask which boxes are in the way, so it errs on the generous side.
  const maxHeight = layout.headlineSize * (1.2 * 2 + 0.6);
  // Narrower than a third of the frame and a headline is a column of single words.
  const minColumn = layout.width * 0.3;

  let chosen: { band: HeadlineBand; fontSize: number; lines: string[] } | null = null;
  for (const band of headlineBands(layout, blocked, maxHeight)) {
    const column = band.right - band.left;
    if (column < minColumn) continue;
    const fit = fitHeadline(ctx, layout, spec, text, column);
    if (fit.lines.length === 0) continue;
    const bottom = band.top + fit.lines.length * fit.fontSize * 1.2 + fit.fontSize * 0.3 * 2;
    if (bottom > ceiling) continue;
    // The first row that takes the text whole wins; a row that only takes it truncated is
    // held as a fallback in case no better one turns up further down.
    if (fit.fits) {
      chosen = { band, fontSize: fit.fontSize, lines: fit.lines };
      break;
    }
    chosen ??= { band, fontSize: fit.fontSize, lines: fit.lines };
  }
  // Nowhere to set it on this frame. Better left off than set unreadably or over the
  // window: the topic is one element among several, and the others were here first.
  if (!chosen) return null;

  const { band, fontSize, lines } = chosen;
  const padX = fontSize * 0.46;
  const padY = fontSize * 0.3;
  const lineHeight = fontSize * 1.2;
  ctx.font = `600 ${fontSize}px ${spec.fonts.sans}`;
  const widest = lines.reduce((max, line) => Math.max(max, trackedWidth(ctx, line, 0)), 0);
  const blockedFromLeft = band.left > layout.safe.left;

  return {
    lines,
    fontSize,
    lineHeight,
    intro: headlineIntro(settings.animation, text, elapsed),
    x: band.left,
    // The panel hugs the text rather than running the whole column, so a three-word
    // topic reads as a label and not as an empty bar.
    width: Math.min(band.right - band.left, widest + padX * 2),
    top: band.top,
    bottom: band.top + lines.length * lineHeight + padY * 2,
    padX,
    padY,
    accentWidth: Math.max(3, fontSize * 0.08),
    // Far enough to read as an entrance, and never further than the frame edge.
    slide: blockedFromLeft ? 0 : Math.min(layout.headlineSize * 1.6, band.left),
  };
}

/** Reveal `shown` characters across pre-wrapped lines, counting the spaces the wrap ate. */
function revealLines(lines: string[], shown: number): string[] {
  let remaining = shown;
  return lines.map((line) => {
    const chars = [...line];
    const visible = remaining <= 0 ? '' : chars.slice(0, remaining).join('');
    remaining -= chars.length + 1;
    return visible;
  });
}

/**
 * The topic, on a quiet panel with an accent rule down its leading edge.
 *
 * The panel is there because the headline has to survive an uploaded photo behind it;
 * it is translucent because at full opacity it becomes a title bar and the video starts
 * to look like a slide. Set in `fonts.sans` — Inter, the one face in the app with
 * Cyrillic in it — for the same reason the subtitles are: a Bulgarian topic in a
 * Latin-only face is fallback glyphs in the exported file.
 */
function paintHeadline(
  ctx: Ctx2D,
  spec: RenderSpec,
  theme: RenderTheme,
  plan: HeadlinePlan,
): void {
  const { intro, fontSize, lineHeight, padX, padY } = plan;
  const opacity = Math.min(1, Math.max(0, intro.opacity));
  if (opacity <= 0.01) return;

  const typing = spec.headline?.animation === 'typewriter';
  const visible = typing ? revealLines(plan.lines, [...intro.text].length) : plan.lines;

  ctx.save();
  ctx.globalAlpha = opacity;
  // `intro.offset` is a fraction of the travel this frame can spare, so a headline hemmed
  // in by the picture window (slide 0) settles in place instead of crossing it.
  ctx.translate(intro.offset * plan.slide, 0);

  const height = plan.bottom - plan.top;
  ctx.fillStyle = rgba(theme.light ? '#FFFFFF' : '#05070A', theme.light ? 0.4 : 0.34);
  roundedRect(ctx, plan.x, plan.top, plan.width, height, fontSize * 0.22);
  ctx.fill();

  ctx.fillStyle = rgba(theme.accent, 0.92);
  roundedRect(ctx, plan.x, plan.top, plan.accentWidth, height, plan.accentWidth / 2);
  ctx.fill();

  ctx.font = `600 ${fontSize}px ${spec.fonts.sans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(theme.light ? '#0D0F12' : '#F6F1E7', 0.96);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = fontSize * 0.16;

  let cursor = plan.top + padY;
  visible.forEach((line, index) => {
    const baseline = cursor + lineHeight * 0.78;
    drawTracked(ctx, line, plan.x + padX, baseline, 0, 'left');
    // Caret on the last line with anything on it, while the typewriter is still going.
    const isLast = index === visible.length - 1 || visible[index + 1] === '';
    if (intro.typing && isLast && line.length > 0) {
      const caretX = plan.x + padX + trackedWidth(ctx, line, 0) + fontSize * 0.08;
      ctx.fillRect(caretX, baseline - fontSize * 0.74, Math.max(2, fontSize * 0.06), fontSize * 0.8);
    }
    cursor += lineHeight;
  });
  ctx.restore();
}

// --- subtitles ------------------------------------------------------------

interface SubtitleLine {
  text: string;
  fontSize: number;
  lineHeight: number;
  color: string;
  weight: number;
}

interface SubtitlePlan {
  lines: SubtitleLine[];
  style: ResolvedSubtitleStyle;
  /** Vertical extent of the whole block, backdrop padding included. */
  top: number;
  bottom: number;
  /** Horizontal extent available to the text. */
  boxLeft: number;
  boxRight: number;
  padX: number;
  padY: number;
  /** How far the progress rail and timings have to move to stay clear. */
  chromeShift: number;
}

/**
 * How far the progress rail and the timings are free to travel this frame.
 *
 * The rail moves out of the subtitles' way, but two other elements have already claimed
 * space it would move into, so the limits are worked out once and handed to everyone who
 * needs them: `subtitleRoom` sizes its slots against them, and `planFrame` clamps the
 * shift it finally applies to the same two numbers. Deriving them twice is how the rail
 * ends up on top of a watermark in one format and not another.
 */
interface ChromeLimits {
  /** The furthest the rail may rise, as a negative shift. Set by the picture window. */
  minShift: number;
  /** The lowest the timings baseline may sit: the safe area, or a bottom watermark. */
  floor: number;
}

function chromeLimits(
  layout: Layout,
  mark: { y: number; isTop: boolean } | null,
  picture: Rect | null,
): ChromeLimits {
  let floor = layout.height - layout.safe.bottom - 24;
  if (mark && !mark.isTop) {
    // Clear of the mark, with the descenders of the timings taken into account.
    floor = Math.min(floor, mark.y - layout.gap - layout.timeSize * 0.24);
  }
  const minShift = picture
    ? Math.min(0, picture.y + picture.height + layout.gap - layout.railY)
    : Number.NEGATIVE_INFINITY;
  return { minShift, floor };
}

/**
 * The vertical space a subtitle position may use, once the chrome has moved as far
 * as it is allowed to.
 *
 * `bottom` sits under the timings, `middle` between the animation and the rail,
 * `top` between the rule and the animation. None of the three can reach the
 * waveform, which is the requirement: subtitles must not cover it.
 *
 * Both ends are the chrome's travel and not the frame's: a block placed as though the
 * rail could rise, when a picture window in a bottom corner is holding it down, is a
 * block with the rail through it.
 */
function subtitleRoom(
  layout: Layout,
  position: SubtitlePosition,
  limits: ChromeLimits,
): { top: number; bottom: number } {
  const stageBottom = layout.stageY + layout.stageHalfHeight;
  const clockGap = layout.timeY - layout.railY;

  if (position === 'top') {
    return { top: layout.ruleY + 34, bottom: layout.stageY - layout.stageHalfHeight - 34 };
  }
  if (position === 'middle') {
    // The rail may slide down as far as the limits allow, no further.
    const maxRailY = Math.max(layout.railY, limits.floor - clockGap);
    return { top: stageBottom + 30, bottom: maxRailY - 30 };
  }
  // The rail may slide up until it would touch the animation or the picture window.
  const minRailY = Math.max(stageBottom + 40, layout.railY + limits.minShift);
  const minTimeY = Math.min(layout.timeY, minRailY + clockGap);
  return { top: minTimeY + 46, bottom: layout.height - layout.safe.bottom };
}

function wrapText(ctx: Ctx2D, text: string, maxWidth: number, tracking: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (trackedWidth(ctx, candidate, tracking) <= maxWidth) current = candidate;
    else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function transformCase(text: string, language: SubtitleLanguage, uppercase: boolean): string {
  if (!uppercase) return text;
  // Locale matters: Bulgarian casing rules differ from the default mapping.
  return text.toLocaleUpperCase(language === 'bg' ? 'bg-BG' : 'en-US');
}

/**
 * Fit the text at the largest size that will hold, shrinking in steps.
 *
 * Returns the best attempt even when nothing fitted, so the caller can compare two
 * placements and pick between them rather than being handed a failure.
 */
function fitSubtitleText(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
  style: ResolvedSubtitleStyle,
  blocks: Array<{ language: SubtitleLanguage; text: string }>,
  boxWidth: number,
  roomHeight: number,
  maxLinesPerBlock: number,
): { lines: SubtitleLine[]; contentHeight: number; padX: number; padY: number; fits: boolean } {
  let lines: SubtitleLine[] = [];
  let contentHeight = 0;
  let padX = 0;
  let padY = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = style.scale * Math.pow(0.9, attempt);
    const baseSize = layout.subtitleSize * scale;
    padX = style.backdrop === 'none' ? 0 : baseSize * 0.52;
    padY = style.backdrop === 'none' ? baseSize * 0.12 : baseSize * 0.4;
    const textWidth = Math.max(120, boxWidth - padX * 2);

    lines = [];
    contentHeight = 0;
    let tooManyLines = false;

    blocks.forEach((block, index) => {
      const fontSize = index === 0 ? baseSize : baseSize * style.secondaryScale;
      const lineHeight = fontSize * 1.24;
      const color = index === 0 ? style.textColor : style.highlightColor;
      ctx.font = `${style.weight} ${fontSize}px ${spec.fonts.sans}`;
      const tracking = style.tracking * (fontSize / 40);
      const text = transformCase(block.text, block.language, style.uppercase);
      let wrapped = wrapText(ctx, text, textWidth, tracking);
      if (wrapped.length > maxLinesPerBlock) {
        tooManyLines = true;
        wrapped = wrapped.slice(0, maxLinesPerBlock);
      }
      if (index > 0) contentHeight += fontSize * 0.22;
      for (const line of wrapped) {
        lines.push({ text: line, fontSize, lineHeight, color, weight: style.weight });
        contentHeight += lineHeight;
      }
    });

    if (!tooManyLines && contentHeight + padY * 2 <= roomHeight) {
      return { lines, contentHeight, padX, padY, fits: true };
    }
  }

  return { lines, contentHeight, padX, padY, fits: false };
}

/**
 * A candidate slot for the subtitle block: how much height it has, and the column it
 * may set type in.
 */
interface SubtitlePlacement {
  room: { top: number; bottom: number };
  boxWidth: number;
  boxLeft: number;
}

/**
 * Take the picture window and the headline out of a subtitle slot.
 *
 * Each obstruction can be escaped two ways — hand back the strip it shares vertically,
 * or the column it shares horizontally — and whichever leaves more area to set type in
 * wins, except that a column narrower than half of what we started with is refused
 * outright: wrapping a sentence into a gutter costs more than the height ever saves.
 *
 * The vertical cut leans towards the side the position asked for, so a bottom subtitle
 * gives up the space above the obstruction rather than below it. It is a lean and not a
 * rule because the obstruction can be at the very edge the position wants: top subtitles
 * with a headline under them have a ten-pixel sliver above it and the rest of the frame
 * below, and a block held to the sliver would be a clipped line rather than a subtitle.
 *
 * `allowHorizontal` is false for the band style, whose backdrop is drawn the full width
 * of the frame — moving that block into a column beside the picture window would leave
 * the text clear of the artwork and the band still lying across it.
 */
function carvePlacement(
  placement: SubtitlePlacement,
  reserved: Rect[],
  position: SubtitlePosition,
  allowHorizontal: boolean,
): SubtitlePlacement {
  let { top, bottom } = placement.room;
  let left = placement.boxLeft;
  let right = placement.boxLeft + placement.boxWidth;
  const minWidth = placement.boxWidth * 0.5;

  for (const rect of reserved) {
    const rectRight = rect.x + rect.width;
    const rectBottom = rect.y + rect.height;
    if (left >= rectRight || right <= rect.x || top >= rectBottom || bottom <= rect.y) continue;

    const above = Math.max(0, rect.y - top);
    const below = Math.max(0, bottom - rectBottom);
    // 1.5 for a top subtitle, its reciprocal for a bottom one: the preferred side wins
    // unless the other is half again as tall, which only happens when the obstruction is
    // sitting on the edge the position asked for.
    const bias = position === 'top' ? 1.5 : position === 'bottom' ? 1 / 1.5 : 1;
    const keepAbove = above * bias >= below;
    const height = keepAbove ? above : below;

    const leftSpace = Math.max(0, rect.x - left);
    const rightSpace = Math.max(0, right - rectRight);
    const keepLeft = leftSpace >= rightSpace;
    const width = keepLeft ? leftSpace : rightSpace;

    const verticalArea = height * (right - left);
    const horizontalArea = (bottom - top) * width;

    if (allowHorizontal && width >= minWidth && horizontalArea > verticalArea) {
      if (keepLeft) right = left + width;
      else left = right - width;
    } else if (keepAbove) {
      bottom = top + height;
    } else {
      top = bottom - height;
    }
  }

  return { room: { top, bottom }, boxLeft: left, boxWidth: Math.max(0, right - left) };
}

/**
 * Decide what the subtitle block looks like this frame, or return null when there
 * is nothing to show.
 *
 * The block is measured before anything is drawn, because both the placement and
 * the chrome offset depend on how tall it turns out to be. When it will not fit the
 * room, the type shrinks in steps rather than spilling out of the safe area.
 *
 * Two placements are tried when the watermark sits along the same edge, because
 * they cannot both have that corner: first the full width with the mark's band left
 * alone, then — where a short format leaves no band to spare — the full height in
 * the column beside it. Only if neither holds does the block take the space anyway,
 * which is the least bad of three bad options.
 *
 * `reserved` carries whatever else has already claimed space — the picture window, the
 * headline — and every candidate is carved against it, so the block is fitted into what
 * is actually free rather than being placed and then found to be on top of something.
 */
function planSubtitles(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
  elapsed: number,
  reserved: Rect[],
  limits: ChromeLimits,
): SubtitlePlan | null {
  const subtitles = spec.subtitles;
  if (!subtitles) return null;
  const { cues, settings } = subtitles;
  const languages = languagesFor(settings.mode);
  if (languages.length === 0 || cues.length === 0) return null;

  const cue = cueAt(cues, elapsed);
  if (!cue) return null;

  const blocks = languages
    .map((language) => ({ language, text: cueText(cue, language) }))
    .filter((block) => block.text.length > 0);
  if (blocks.length === 0) return null;

  const style = resolveSubtitleStyle(settings);
  // Two lines on screen at once, total. Bilingual therefore gets one line each.
  const maxLinesPerBlock = blocks.length > 1 ? 1 : 2;
  const room = subtitleRoom(layout, settings.position, limits);

  const safeLeft = layout.safe.left;
  const safeRight = layout.width - layout.safe.right;
  const available = safeRight - safeLeft;
  const fullWidth = Math.min(layout.subtitleMaxWidth, available);
  const centred = (width: number) => safeLeft + (available - width) / 2;

  const mark = watermarkBox(ctx, layout, spec);
  const shares =
    mark !== null &&
    ((mark.isTop && settings.position === 'top') ||
      (!mark.isTop && settings.position === 'bottom'));

  const raw: SubtitlePlacement[] = [];
  if (shares && mark) {
    const gap = mark.size * 0.55;
    raw.push({
      room:
        settings.position === 'top'
          ? { top: Math.max(room.top, mark.y + mark.height + gap), bottom: room.bottom }
          : { top: room.top, bottom: Math.min(room.bottom, mark.y - gap) },
      boxWidth: fullWidth,
      boxLeft: centred(fullWidth),
    });

    // Beside the mark: only worth offering while the column left over is wide
    // enough to read in. Narrower than half the safe area and the wrapping costs
    // more than the overlap would. Never offered to the band style, whose backdrop is
    // drawn the full width of the frame and would lie across the mark from any column.
    const markLeft = mark.x;
    const markRight = mark.x + mark.width;
    const columnLeft = markLeft > layout.width / 2 ? safeLeft : markRight + gap;
    const columnRight = markLeft > layout.width / 2 ? markLeft - gap : safeRight;
    const columnWidth = Math.min(layout.subtitleMaxWidth, columnRight - columnLeft);
    if (style.backdrop !== 'band' && columnWidth >= available * 0.5) {
      raw.push({ room, boxWidth: columnWidth, boxLeft: columnLeft });
    }
  } else {
    raw.push({ room, boxWidth: fullWidth, boxLeft: centred(fullWidth) });
  }

  // The window and the headline are already placed, so they are a constraint here
  // rather than a candidate to weigh: every slot is carved before it is measured.
  const placements = raw.map((placement) =>
    carvePlacement(placement, reserved, settings.position, style.backdrop !== 'band'),
  );

  let chosen = placements[0];
  let attempt = fitSubtitleText(
    ctx,
    layout,
    spec,
    style,
    blocks,
    chosen.boxWidth,
    Math.max(0, chosen.room.bottom - chosen.room.top),
    maxLinesPerBlock,
  );

  for (let i = 1; i < placements.length && !attempt.fits; i++) {
    const candidate = placements[i];
    const next = fitSubtitleText(
      ctx,
      layout,
      spec,
      style,
      blocks,
      candidate.boxWidth,
      Math.max(0, candidate.room.bottom - candidate.room.top),
      maxLinesPerBlock,
    );
    if (next.fits || next.lines.length > attempt.lines.length) {
      chosen = candidate;
      attempt = next;
    }
  }

  const { lines, contentHeight, padX, padY, fits } = attempt;
  if (lines.length === 0) return null;

  const roomHeight = Math.max(0, chosen.room.bottom - chosen.room.top);
  // A block that fits keeps its measured height; one that does not is held to the
  // room so it cannot spill past the safe area, and loses the overflow instead.
  const blockHeight = fits ? contentHeight + padY * 2 : Math.min(roomHeight, contentHeight + padY * 2);
  if (blockHeight <= 0) return null;

  const top = settings.position === 'bottom' ? chosen.room.bottom - blockHeight : chosen.room.top;
  const bottom = top + blockHeight;

  let chromeShift = 0;
  if (settings.position === 'bottom') {
    chromeShift = Math.min(0, top - 44 - layout.timeY);
  } else if (settings.position === 'middle') {
    chromeShift = Math.max(0, bottom + 30 - layout.railY);
  }

  return {
    lines,
    style,
    top,
    bottom,
    boxLeft: chosen.boxLeft,
    boxRight: chosen.boxLeft + chosen.boxWidth,
    padX,
    padY,
    chromeShift,
  };
}

function paintSubtitles(ctx: Ctx2D, layout: Layout, spec: RenderSpec, plan: SubtitlePlan): void {
  const { style, lines, padX, padY } = plan;
  const align = spec.subtitles?.settings.align ?? 'center';

  // Widest line decides the panel width; each line decides its own pill.
  const widths = lines.map((line) => {
    ctx.font = `${line.weight} ${line.fontSize}px ${spec.fonts.sans}`;
    return trackedWidth(ctx, line.text, style.tracking * (line.fontSize / 40));
  });
  const widest = widths.reduce((max, w) => Math.max(max, w), 0);

  const anchorX =
    align === 'left'
      ? plan.boxLeft + padX
      : align === 'right'
        ? plan.boxRight - padX
        : (plan.boxLeft + plan.boxRight) / 2;

  const panelLeft =
    align === 'left'
      ? plan.boxLeft
      : align === 'right'
        ? plan.boxRight - widest - padX * 2
        : (plan.boxLeft + plan.boxRight) / 2 - widest / 2 - padX;
  const panelWidth = widest + padX * 2;

  ctx.save();
  if (style.backdrop === 'band') {
    ctx.fillStyle = rgba(style.backdropColor, style.backdropAlpha);
    ctx.fillRect(0, plan.top, layout.width, plan.bottom - plan.top);
  } else if (style.backdrop === 'panel') {
    ctx.fillStyle = rgba(style.backdropColor, style.backdropAlpha);
    roundedRect(
      ctx,
      panelLeft,
      plan.top,
      panelWidth,
      plan.bottom - plan.top,
      lines[0].fontSize * 0.34,
    );
    ctx.fill();
  }
  ctx.restore();

  let cursor = plan.top + padY;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, index) => {
    const baseline = cursor + line.lineHeight * 0.78;
    const tracking = style.tracking * (line.fontSize / 40);
    ctx.font = `${line.weight} ${line.fontSize}px ${spec.fonts.sans}`;

    if (style.backdrop === 'highlight') {
      // A pill per line hugs ragged text far better than one box around the block.
      const pillPadX = line.fontSize * 0.34;
      const pillPadY = line.fontSize * 0.16;
      const w = widths[index] + pillPadX * 2;
      const left =
        align === 'left'
          ? anchorX - pillPadX
          : align === 'right'
            ? anchorX - widths[index] - pillPadX
            : anchorX - w / 2;
      ctx.save();
      ctx.fillStyle = rgba(style.backdropColor, style.backdropAlpha);
      roundedRect(ctx, left, cursor - pillPadY, w, line.lineHeight + pillPadY * 2, line.fontSize * 0.3);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (style.shadow > 0) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.62)';
      ctx.shadowBlur = style.shadow;
      ctx.shadowOffsetY = style.shadow * 0.22;
    }
    ctx.fillStyle = line.color;
    drawTracked(
      ctx,
      line.text,
      anchorX,
      baseline,
      tracking,
      align,
      style.outline > 0 ? { width: style.outline, color: 'rgba(6, 8, 11, 0.92)' } : undefined,
    );
    ctx.restore();

    cursor += line.lineHeight;
  });
  ctx.restore();
}

// --- watermark ------------------------------------------------------------

/** Every dimension of the mark, derived from the one type size in the layout. */
function watermarkMetrics(size: number) {
  const padY = size * 0.42;
  return {
    size,
    prefixSize: size * 0.7,
    iconWidth: size * 0.92,
    gap: size * 0.36,
    padX: size * 0.6,
    padY,
    height: size * 1.28 + padY * 2,
  };
}

/**
 * Where the mark will land, measured before anything is drawn.
 *
 * Subtitles need this as much as the painter does: a bottom-right mark and a
 * bottom-aligned subtitle block are both inside the same safe area, so one of them
 * has to give way, and it cannot give way to a rectangle nobody measured. Returns
 * null when the mark is switched off, which is also the "nothing to avoid" answer.
 *
 * Font state is left as it was found — callers measure their own text afterwards.
 */
function watermarkBox(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
): { x: number; y: number; width: number; height: number; size: number; isTop: boolean } | null {
  const watermark = spec.watermark;
  if (!watermark || !watermark.enabled) return null;

  const m = watermarkMetrics(layout.watermarkSize);
  const previousFont = ctx.font;
  ctx.font = `400 ${m.prefixSize}px ${spec.fonts.sans}`;
  const prefixWidth = trackedWidth(ctx, WATERMARK_PREFIX, 0);
  ctx.font = `700 ${m.size}px ${spec.fonts.sans}`;
  const nameWidth = trackedWidth(ctx, WATERMARK_NAME, m.size * 0.06);
  ctx.font = previousFont;

  const width = m.iconWidth + m.gap + prefixWidth + m.gap * 0.8 + nameWidth + m.padX * 2;
  const isTop = watermark.position === 'top-left' || watermark.position === 'top-right';
  const isLeft = watermark.position === 'top-left' || watermark.position === 'bottom-left';

  return {
    x: isLeft ? layout.safe.left : layout.width - layout.safe.right - width,
    // A top corner is measured from below the rule rather than from the safe inset:
    // in Story the platform's safe top lands inside the logo row, and a mark with the
    // hairline running through it is a covered mark.
    y: isTop
      ? Math.max(layout.safe.top, layout.ruleY + layout.gap)
      : layout.height - layout.safe.bottom - m.height,
    width,
    height: m.height,
    size: m.size,
    isTop,
  };
}

/**
 * "Made with GLASKO", in a corner, inside the platform safe area.
 *
 * Drawn as one row — icon, then the small prefix, then the wordmark set heavier and
 * brighter so the name reads first. The pill behind it is what makes it survive a
 * busy photo; without it the mark disappears into anything light.
 */
function paintWatermark(ctx: Ctx2D, layout: Layout, spec: RenderSpec, theme: RenderTheme): void {
  const box = watermarkBox(ctx, layout, spec);
  if (!box) return;

  const { size, prefixSize, iconWidth, gap, padX } = watermarkMetrics(box.size);
  const pillWidth = box.width;
  const pillHeight = box.height;
  const x = box.x;
  const y = box.y;

  ctx.save();

  // Light backgrounds need a light pill with dark ink, or the mark reads as a hole.
  const pillColor = theme.light ? '#FFFFFF' : '#05070A';
  const inkColor = theme.light ? '#0D0F12' : '#F6F1E7';

  ctx.globalAlpha = 0.88;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = size * 0.5;
  ctx.shadowOffsetY = size * 0.1;
  ctx.fillStyle = rgba(pillColor, theme.light ? 0.42 : 0.34);
  roundedRect(ctx, x, y, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Soundwave icon: four rounded bars, tallest in the middle.
  const iconX = x + padX;
  const centreY = y + pillHeight / 2;
  const barWidth = iconWidth / 7;
  const heights = [0.42, 0.9, 0.66, 0.3].map((factor) => factor * size);
  ctx.fillStyle = rgba(theme.accent, 0.95);
  heights.forEach((height, index) => {
    const bx = iconX + index * (barWidth * 1.75);
    roundedRect(ctx, bx, centreY - height / 2, barWidth, height, barWidth / 2);
    ctx.fill();
  });

  const textY = centreY + size * 0.34;
  let cursor = iconX + iconWidth + gap;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `400 ${prefixSize}px ${spec.fonts.sans}`;
  ctx.fillStyle = rgba(inkColor, 0.62);
  drawTracked(ctx, WATERMARK_PREFIX, cursor, textY - size * 0.02, 0);
  cursor += trackedWidth(ctx, WATERMARK_PREFIX, 0) + gap * 0.8;
  ctx.font = `700 ${size}px ${spec.fonts.sans}`;
  ctx.fillStyle = rgba(inkColor, 0.96);
  drawTracked(ctx, WATERMARK_NAME, cursor, textY, size * 0.06);
  ctx.restore();
}

/**
 * Everything the frame has decided about where things go, before anything is drawn.
 *
 * Split out of `drawFrame` so the layout can be asserted rather than eyeballed: it is a
 * pure function of the format, the settings and the elapsed second, and it is the same
 * function the preview and the encoder run. `scripts/check-frame-layout.mjs` walks it
 * across every combination of format, motion, window and subtitle mode and fails the
 * build if two boxes touch — see `frameBoxes`.
 */
interface FramePlan {
  layout: Layout;
  /** The logo row and the rule under it. Fixed. */
  chrome: Rect;
  /** What the motion occupies, or null for `none`. Fixed. */
  stage: Rect | null;
  picture: PicturePlan | null;
  headline: HeadlinePlan | null;
  subtitles: SubtitlePlan | null;
  /** The attribution mark, or null in the impossible case of it being switched off. */
  watermark: Rect | null;
  /** How far the progress rail and the timings move to keep out of the way. */
  chromeShift: number;
}

function planFrame(ctx: Ctx2D, layout: Layout, spec: RenderSpec, elapsed: number): FramePlan {
  // The picture window goes into the largest corner nothing else has claimed. The band it
  // may use starts under the logo row and stops above the progress rail, so it can never
  // reach either; the motion and the watermark are passed in as boxes to avoid, so it
  // cannot reach those either.
  const chrome = topChromeRect(layout, spec);
  const mark = watermarkBox(ctx, layout, spec);
  const stage = stageRect(layout, spec);
  const blocked: Rect[] = [];
  if (stage) blocked.push(padRect(stage, layout.gap));
  if (mark) blocked.push(padRect(mark, layout.gap));

  const picture =
    spec.picture?.image
      ? planPicture({
          layout,
          settings: spec.picture.settings,
          blocked,
          band: {
            top: Math.max(chrome.y + chrome.height + layout.gap, layout.safe.top),
            bottom: Math.min(layout.railY - layout.gap, layout.height - layout.safe.bottom),
          },
        })
      : null;
  if (picture) blocked.push(padRect(picture, layout.gap));

  // The headline takes the topmost row the window and the mark leave it, re-wrapping into
  // what is left. Its floor is the animation stage, or the rail when there is no stage.
  const headline = planHeadline(
    ctx,
    layout,
    spec,
    elapsed,
    blocked,
    (stage ? stage.y : layout.railY) - layout.gap,
  );

  const limits = chromeLimits(layout, mark, picture);

  // Subtitles are measured before the chrome is drawn so the chrome can move out of
  // their way instead of overlapping them.
  const reserved: Rect[] = [];
  if (picture) reserved.push(padRect(picture, layout.gap));
  if (headline) {
    reserved.push(
      padRect(
        {
          x: headline.x,
          y: headline.top,
          width: headline.width,
          height: headline.bottom - headline.top,
        },
        layout.gap,
      ),
    );
  }
  const subtitles = planSubtitles(ctx, layout, spec, elapsed, reserved, limits);

  // The chrome yields to the subtitles, within the travel it was given: it may not rise
  // into the picture window, and it may not descend onto the watermark.
  const wanted = subtitles?.chromeShift ?? 0;
  const ceiling = Math.max(limits.minShift, limits.floor - layout.timeY);
  const chromeShift = Math.min(Math.max(wanted, limits.minShift), ceiling);

  return { layout, chrome, stage, picture, headline, subtitles, watermark: mark, chromeShift };
}

/**
 * The plan as plain named rectangles, in the position they are actually drawn.
 *
 * The headline's box carries its slide offset, so a check run a fraction of a second into
 * the clip sees the block mid-entrance rather than where it will end up — the overlap a
 * moving element causes is still an overlap.
 *
 * `insideSafeArea` is false for the three elements that are designed to reach past it:
 * the logo row, which sits above the safe top by construction, the progress rail, which
 * spans the frame at the page margin, and the band subtitle backdrop, which is drawn the
 * full width on purpose. The text inside that band is reported separately and is held to
 * the safe area like everything else.
 */
export interface FrameBox {
  name: string;
  rect: Rect;
  insideSafeArea: boolean;
}

export function frameBoxes(ctx: Ctx2D, spec: RenderSpec, elapsed: number): FrameBox[] {
  const layout = layoutFor(spec.format ?? DEFAULT_FORMAT);
  const plan = planFrame(ctx, layout, spec, elapsed);
  const boxes: FrameBox[] = [];

  boxes.push({ name: 'logo', rect: plan.chrome, insideSafeArea: false });

  // The rail, the playhead dot and the two timings, after the shift.
  const railTop = layout.railY + plan.chromeShift - 8;
  boxes.push({
    name: 'progress',
    rect: {
      x: layout.margin,
      y: railTop,
      width: layout.width - layout.margin * 2,
      height: layout.timeY + plan.chromeShift + layout.timeSize * 0.24 - railTop,
    },
    insideSafeArea: false,
  });

  if (plan.stage) boxes.push({ name: 'motion', rect: plan.stage, insideSafeArea: true });
  if (plan.picture) {
    const { x, y, width, height } = plan.picture;
    boxes.push({ name: 'picture', rect: { x, y, width, height }, insideSafeArea: true });
  }
  if (plan.headline) {
    const h = plan.headline;
    boxes.push({
      name: 'headline',
      rect: {
        x: h.x + h.intro.offset * h.slide,
        y: h.top,
        width: h.width,
        height: h.bottom - h.top,
      },
      // Where it comes to rest is held to the safe area; the entrance is allowed to
      // start out in the page margin, which is what makes it read as an entrance.
      insideSafeArea: h.intro.offset === 0,
    });
  }
  if (plan.subtitles) {
    const s = plan.subtitles;
    const height = s.bottom - s.top;
    boxes.push({
      name: 'subtitles',
      rect: { x: s.boxLeft, y: s.top, width: s.boxRight - s.boxLeft, height },
      insideSafeArea: true,
    });
    if (s.style.backdrop === 'band') {
      boxes.push({
        name: 'subtitle-band',
        rect: { x: 0, y: s.top, width: layout.width, height },
        insideSafeArea: false,
      });
    }
  }
  if (plan.watermark) boxes.push({ name: 'watermark', rect: plan.watermark, insideSafeArea: true });

  return boxes;
}

/**
 * Paint one frame. `scale` maps the format's design space onto the target canvas,
 * so a 405px-wide preview of a 1080-wide format passes `0.375`.
 *
 * The order below is the stacking order, which is why the watermark is painted last of
 * the overlays — nothing can be drawn over the attribution. Where each element goes is
 * `planFrame`'s answer, not this function's.
 */
export function drawFrame(
  ctx: Ctx2D,
  frame: FrameData,
  spec: RenderSpec,
  frameIndex: number,
  scale = 1,
): void {
  const layout = layoutFor(spec.format ?? DEFAULT_FORMAT);

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, layout.width, layout.height);

  const theme = themeFor(spec.background);
  paintBackground(ctx, layout, spec, theme);

  // The animation layer is skipped outright for `none` — no placeholder, no rail,
  // no minimum-amplitude line. Every pipeline shares this call, so the exported MP4
  // omits it for exactly the same reason the preview does.
  if (spec.animation === 'wave') paintWave(ctx, layout, frame, theme);
  else if (spec.animation === 'bars') paintBars(ctx, layout, frame, theme);
  else if (spec.animation === 'pulse') paintPulse(ctx, layout, frame, theme);

  const plan = planFrame(ctx, layout, spec, frame.elapsed);

  const pictureImage = spec.picture?.image ?? null;
  if (plan.picture && pictureImage) paintPicture(ctx, spec, theme, plan.picture, pictureImage);
  if (plan.headline) paintHeadline(ctx, spec, theme, plan.headline);

  paintChrome(ctx, layout, frame, spec, theme, plan.chromeShift);
  if (plan.subtitles) paintSubtitles(ctx, layout, spec, plan.subtitles);
  paintWatermark(ctx, layout, spec, theme);
  paintGrain(ctx, layout, frameIndex);

  ctx.restore();
}
