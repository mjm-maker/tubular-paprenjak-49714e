/**
 * Canvas compositor for a single video frame.
 *
 * Drawing always happens in a fixed 1080x1920 coordinate space and is scaled by a
 * transform, so the on-screen preview and the exported MP4 are the same picture at
 * different resolutions — there is only one renderer to keep in sync.
 */

import { BAND_COUNT, type FrameData } from './analysis';
import {
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  type AnimationKind,
  type BackgroundChoice,
  type RenderTheme,
  rgba,
  themeFor,
} from './theme';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderSpec {
  background: BackgroundChoice;
  /** Loaded bitmap for an uploaded image background. */
  backgroundImage?: CanvasImageSource | null;
  animation: AnimationKind;
  fonts: { display: string; mono: string };
}

const MARGIN = 92;
const CENTRE_X = VIDEO_WIDTH / 2;
const STAGE_Y = 900;
const STAGE_HALF_HEIGHT = 210;
const RAIL_Y = 1268;
const TIME_Y = 1338;
const WORDMARK_Y = 226;
const RULE_Y = 276;

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

/** Draw text with explicit letter spacing (ctx.letterSpacing is not universal). */
function drawTracked(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: 'left' | 'right' = 'left',
): void {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + tracking * Math.max(0, chars.length - 1);
  let cursor = align === 'left' ? x : x - total;
  ctx.textAlign = 'left';
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

function paintBackground(ctx: Ctx2D, spec: RenderSpec, theme: RenderTheme): void {
  const { background, backgroundImage } = spec;

  if (background.kind === 'image' && backgroundImage) {
    const size = imageSize(backgroundImage);
    if (size) {
      // Cover-fit, centred.
      const scale = Math.max(VIDEO_WIDTH / size.width, VIDEO_HEIGHT / size.height);
      const w = size.width * scale;
      const h = size.height * scale;
      ctx.drawImage(backgroundImage, (VIDEO_WIDTH - w) / 2, (VIDEO_HEIGHT - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#0D0F12';
      ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    }

    // Scrim: keeps the wordmark, timings and animation readable over any photo.
    const scrim = ctx.createLinearGradient(0, 0, 0, VIDEO_HEIGHT);
    scrim.addColorStop(0, 'rgba(8, 10, 13, 0.72)');
    scrim.addColorStop(0.34, 'rgba(8, 10, 13, 0.36)');
    scrim.addColorStop(0.62, 'rgba(8, 10, 13, 0.42)');
    scrim.addColorStop(1, 'rgba(8, 10, 13, 0.78)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    return;
  }

  if (background.kind === 'gradient') {
    const radians = (background.angle * Math.PI) / 180;
    const halfDiagonal = Math.hypot(VIDEO_WIDTH, VIDEO_HEIGHT) / 2;
    const dx = Math.cos(radians) * halfDiagonal;
    const dy = Math.sin(radians) * halfDiagonal;
    const gradient = ctx.createLinearGradient(
      CENTRE_X - dx,
      VIDEO_HEIGHT / 2 - dy,
      CENTRE_X + dx,
      VIDEO_HEIGHT / 2 + dy,
    );
    gradient.addColorStop(0, background.from);
    gradient.addColorStop(1, background.to);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = background.kind === 'solid' ? background.color : '#0D0F12';
  }
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Vignette adds depth so flat colours do not read as a blank slide.
  const vignette = ctx.createRadialGradient(
    CENTRE_X,
    STAGE_Y - 60,
    120,
    CENTRE_X,
    STAGE_Y - 60,
    1180,
  );
  vignette.addColorStop(0, rgba(theme.light ? '#FFFFFF' : '#FFFFFF', theme.light ? 0.22 : 0.07));
  vignette.addColorStop(1, rgba('#000000', theme.light ? 0.1 : 0.28));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
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

function paintGrain(ctx: Ctx2D, frameIndex: number): void {
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
  ctx.fillRect(0, 0, VIDEO_WIDTH + 128, VIDEO_HEIGHT + 128);
  ctx.restore();
}

function paintWave(ctx: Ctx2D, frame: FrameData, theme: RenderTheme): void {
  const wave = frame.wave;
  const usable = VIDEO_WIDTH - MARGIN * 2;
  const step = usable / (wave.length - 1);
  const minAmplitude = 3;

  const buildPath = () => {
    ctx.beginPath();
    // Top edge, left to right.
    for (let i = 0; i < wave.length; i++) {
      const x = MARGIN + i * step;
      const y = STAGE_Y - Math.max(minAmplitude, wave[i] * STAGE_HALF_HEIGHT);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Mirrored bottom edge, right to left.
    for (let i = wave.length - 1; i >= 0; i--) {
      const x = MARGIN + i * step;
      const y = STAGE_Y + Math.max(minAmplitude, wave[i] * STAGE_HALF_HEIGHT);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  // Upcoming audio: quiet.
  ctx.save();
  buildPath();
  ctx.fillStyle = rgba(theme.fg, 0.26);
  ctx.fill();
  ctx.restore();

  // Already-played audio: accent, clipped to the left of the playhead.
  ctx.save();
  ctx.beginPath();
  ctx.rect(MARGIN, STAGE_Y - STAGE_HALF_HEIGHT - 20, CENTRE_X - MARGIN, STAGE_HALF_HEIGHT * 2 + 40);
  ctx.clip();
  buildPath();
  ctx.fillStyle = rgba(theme.accent, 0.92);
  ctx.fill();
  ctx.restore();

  // Playhead.
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.9);
  roundedRect(ctx, CENTRE_X - 2.5, STAGE_Y - STAGE_HALF_HEIGHT - 34, 5, STAGE_HALF_HEIGHT * 2 + 68, 3);
  ctx.fill();
  const dotRadius = 9 + frame.level * 7;
  ctx.beginPath();
  ctx.arc(CENTRE_X, STAGE_Y - STAGE_HALF_HEIGHT - 34, dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.accent, 0.95);
  ctx.fill();
  ctx.restore();
}

function paintBars(ctx: Ctx2D, frame: FrameData, theme: RenderTheme): void {
  const usable = VIDEO_WIDTH - MARGIN * 2;
  const gap = 9;
  const barWidth = (usable - gap * (BAND_COUNT - 1)) / BAND_COUNT;
  const radius = barWidth / 2;
  const minHeight = barWidth * 0.9;

  const gradient = ctx.createLinearGradient(0, STAGE_Y - STAGE_HALF_HEIGHT, 0, STAGE_Y + STAGE_HALF_HEIGHT);
  gradient.addColorStop(0, rgba(theme.accent, 0.95));
  gradient.addColorStop(0.5, rgba(theme.fg, 0.95));
  gradient.addColorStop(1, rgba(theme.accent, 0.95));

  ctx.save();
  ctx.fillStyle = gradient;
  for (let b = 0; b < BAND_COUNT; b++) {
    const magnitude = frame.bands[b] ?? 0;
    const half = Math.max(minHeight / 2, magnitude * STAGE_HALF_HEIGHT);
    const x = MARGIN + b * (barWidth + gap);
    roundedRect(ctx, x, STAGE_Y - half, barWidth, half * 2, radius);
    ctx.fill();
  }
  ctx.restore();

  // Centre hairline ties the bars together and marks silence.
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.2);
  ctx.fillRect(MARGIN, STAGE_Y - 1, usable, 2);
  ctx.restore();
}

function paintChrome(
  ctx: Ctx2D,
  frame: FrameData,
  spec: RenderSpec,
  theme: RenderTheme,
): void {
  // Brand mark: three ascending bars, then the wordmark.
  ctx.save();
  ctx.fillStyle = rgba(theme.accent, 0.95);
  const markHeights = [22, 38, 28];
  markHeights.forEach((height, index) => {
    roundedRect(ctx, MARGIN + index * 13, WORDMARK_Y - height, 7, height, 3.5);
    ctx.fill();
  });

  ctx.fillStyle = rgba(theme.fg, 0.9);
  ctx.font = `500 44px ${spec.fonts.display}`;
  ctx.textBaseline = 'alphabetic';
  drawTracked(ctx, 'GLASKO', MARGIN + 60, WORDMARK_Y, 7);

  ctx.font = `500 22px ${spec.fonts.mono}`;
  ctx.fillStyle = rgba(theme.fg, 0.45);
  drawTracked(ctx, formatClock(frame.duration), VIDEO_WIDTH - MARGIN, WORDMARK_Y - 4, 3, 'right');

  ctx.fillStyle = rgba(theme.fg, 0.16);
  ctx.fillRect(MARGIN, RULE_Y, VIDEO_WIDTH - MARGIN * 2, 2);
  ctx.restore();

  // Progress rail.
  const railWidth = VIDEO_WIDTH - MARGIN * 2;
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.16);
  roundedRect(ctx, MARGIN, RAIL_Y, railWidth, 6, 3);
  ctx.fill();
  const played = railWidth * Math.min(1, Math.max(0, frame.progress));
  ctx.fillStyle = rgba(theme.accent, 0.95);
  roundedRect(ctx, MARGIN, RAIL_Y, Math.max(6, played), 6, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(MARGIN + played, RAIL_Y + 3, 11, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.fg, 0.95);
  ctx.fill();
  ctx.restore();

  // Timings.
  ctx.save();
  ctx.font = `500 28px ${spec.fonts.mono}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(theme.fg, 0.62);
  drawTracked(ctx, formatClock(frame.elapsed), MARGIN, TIME_Y, 2);
  ctx.fillStyle = rgba(theme.fg, 0.34);
  drawTracked(ctx, '-' + formatClock(Math.max(0, frame.duration - frame.elapsed)), VIDEO_WIDTH - MARGIN, TIME_Y, 2, 'right');
  ctx.restore();
}

/**
 * Paint one frame. `scale` maps the fixed 1080x1920 design space onto the target
 * canvas, so a 405px-wide preview passes `0.375`.
 */
export function drawFrame(
  ctx: Ctx2D,
  frame: FrameData,
  spec: RenderSpec,
  frameIndex: number,
  scale = 1,
): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  const theme = themeFor(spec.background);
  paintBackground(ctx, spec, theme);

  if (spec.animation === 'wave') paintWave(ctx, frame, theme);
  else paintBars(ctx, frame, theme);

  paintChrome(ctx, frame, spec, theme);
  paintGrain(ctx, frameIndex);

  ctx.restore();
}
