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
import { DEFAULT_FORMAT, type Layout, layoutFor, type VideoFormat } from './layout';
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
  subtitles?: { cues: SubtitleCue[]; settings: SubtitleSettings } | null;
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

function paintWave(ctx: Ctx2D, layout: Layout, frame: FrameData, theme: RenderTheme): void {
  const wave = frame.wave;
  const { margin, width, centreX, stageY, stageHalfHeight } = layout;
  const usable = width - margin * 2;
  const step = usable / (wave.length - 1);
  const minAmplitude = 3;

  const buildPath = () => {
    ctx.beginPath();
    // Top edge, left to right.
    for (let i = 0; i < wave.length; i++) {
      const x = margin + i * step;
      const y = stageY - Math.max(minAmplitude, wave[i] * stageHalfHeight);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Mirrored bottom edge, right to left.
    for (let i = wave.length - 1; i >= 0; i--) {
      const x = margin + i * step;
      const y = stageY + Math.max(minAmplitude, wave[i] * stageHalfHeight);
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
  ctx.rect(margin, stageY - stageHalfHeight - 20, centreX - margin, stageHalfHeight * 2 + 40);
  ctx.clip();
  buildPath();
  ctx.fillStyle = rgba(theme.accent, 0.92);
  ctx.fill();
  ctx.restore();

  // Playhead.
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.9);
  roundedRect(ctx, centreX - 2.5, stageY - stageHalfHeight - 34, 5, stageHalfHeight * 2 + 68, 3);
  ctx.fill();
  const dotRadius = 9 + frame.level * 7;
  ctx.beginPath();
  ctx.arc(centreX, stageY - stageHalfHeight - 34, dotRadius, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.accent, 0.95);
  ctx.fill();
  ctx.restore();
}

function paintBars(ctx: Ctx2D, layout: Layout, frame: FrameData, theme: RenderTheme): void {
  const { margin, width, stageY, stageHalfHeight, barGap: gap } = layout;
  const usable = width - margin * 2;
  const barWidth = (usable - gap * (BAND_COUNT - 1)) / BAND_COUNT;
  const radius = barWidth / 2;
  const minHeight = barWidth * 0.9;

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
  for (let b = 0; b < BAND_COUNT; b++) {
    const magnitude = frame.bands[b] ?? 0;
    const half = Math.max(minHeight / 2, magnitude * stageHalfHeight);
    const x = margin + b * (barWidth + gap);
    roundedRect(ctx, x, stageY - half, barWidth, half * 2, radius);
    ctx.fill();
  }
  ctx.restore();

  // Centre hairline ties the bars together and marks silence.
  ctx.save();
  ctx.fillStyle = rgba(theme.fg, 0.2);
  ctx.fillRect(margin, stageY - 1, usable, 2);
  ctx.restore();
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

  // Brand mark: three ascending bars, then the wordmark.
  ctx.save();
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

  ctx.font = `500 ${layout.clockSize}px ${spec.fonts.mono}`;
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
 * The vertical space a subtitle position may use, once the chrome has moved as far
 * as it is allowed to.
 *
 * `bottom` sits under the timings, `middle` between the animation and the rail,
 * `top` between the rule and the animation. None of the three can reach the
 * waveform, which is the requirement: subtitles must not cover it.
 */
function subtitleRoom(layout: Layout, position: SubtitlePosition): { top: number; bottom: number } {
  const stageBottom = layout.stageY + layout.stageHalfHeight;
  const clockGap = layout.timeY - layout.railY;

  if (position === 'top') {
    return { top: layout.ruleY + 34, bottom: layout.stageY - layout.stageHalfHeight - 34 };
  }
  if (position === 'middle') {
    // The rail may slide down to the edge of the safe area, no further.
    const maxTimeY = layout.height - layout.safe.bottom - 24;
    const maxRailY = Math.max(layout.railY, maxTimeY - clockGap);
    return { top: stageBottom + 30, bottom: maxRailY - 30 };
  }
  // The rail may slide up until it would touch the animation.
  const minRailY = stageBottom + 40;
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
 */
function planSubtitles(
  ctx: Ctx2D,
  layout: Layout,
  spec: RenderSpec,
  elapsed: number,
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
  const room = subtitleRoom(layout, settings.position);

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

  interface Placement {
    room: { top: number; bottom: number };
    boxWidth: number;
    boxLeft: number;
  }

  const placements: Placement[] = [];
  if (shares && mark) {
    const gap = mark.size * 0.55;
    placements.push({
      room:
        settings.position === 'top'
          ? { top: Math.max(room.top, mark.y + mark.height + gap), bottom: room.bottom }
          : { top: room.top, bottom: Math.min(room.bottom, mark.y - gap) },
      boxWidth: fullWidth,
      boxLeft: centred(fullWidth),
    });

    // Beside the mark: only worth offering while the column left over is wide
    // enough to read in. Narrower than half the safe area and the wrapping costs
    // more than the overlap would.
    const markLeft = mark.x;
    const markRight = mark.x + mark.width;
    const columnLeft = markLeft > layout.width / 2 ? safeLeft : markRight + gap;
    const columnRight = markLeft > layout.width / 2 ? markLeft - gap : safeRight;
    const columnWidth = Math.min(layout.subtitleMaxWidth, columnRight - columnLeft);
    if (columnWidth >= available * 0.5) {
      placements.push({ room, boxWidth: columnWidth, boxLeft: columnLeft });
    }
  } else {
    placements.push({ room, boxWidth: fullWidth, boxLeft: centred(fullWidth) });
  }

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
    y: isTop ? layout.safe.top : layout.height - layout.safe.bottom - m.height,
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
 * Paint one frame. `scale` maps the format's design space onto the target canvas,
 * so a 405px-wide preview of a 1080-wide format passes `0.375`.
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

  // Subtitles are measured before the chrome is drawn so the chrome can move out
  // of their way instead of overlapping them.
  const plan = planSubtitles(ctx, layout, spec, frame.elapsed);
  paintChrome(ctx, layout, frame, spec, theme, plan?.chromeShift ?? 0);
  if (plan) paintSubtitles(ctx, layout, spec, plan);
  paintWatermark(ctx, layout, spec, theme);
  paintGrain(ctx, layout, frameIndex);

  ctx.restore();
}
