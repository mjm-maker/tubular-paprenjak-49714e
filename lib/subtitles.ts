/**
 * Subtitle model: cues, language modes, presets, and the two sidecar formats.
 *
 * Cues live in one shape regardless of language mode — each cue carries both a
 * Bulgarian and an English string, and the mode decides which of them get drawn.
 * That keeps switching between "Bulgarian", "English" and "Both" free: no
 * re-transcription, no re-translation, just a different read of the same array.
 *
 * Everything here is pure data and pure functions. The drawing lives in
 * `lib/render.ts` so that subtitles obey the rendering contract and appear in the
 * exported file, not only the preview.
 */

export type SubtitleLanguage = 'bg' | 'en';
export type SubtitleMode = 'none' | 'bg' | 'en' | 'both';

export const SUBTITLE_MODES: Array<{ id: SubtitleMode; label: string; blurb: string }> = [
  { id: 'none', label: 'No subtitles', blurb: 'Voice and visuals only' },
  { id: 'bg', label: 'Български', blurb: 'Bulgarian subtitles' },
  { id: 'en', label: 'English', blurb: 'English subtitles' },
  { id: 'both', label: 'Both', blurb: 'Bulgarian above, English below' },
];

export const LANGUAGE_LABEL: Record<SubtitleLanguage, string> = {
  bg: 'Български',
  en: 'English',
};

export interface SubtitleCue {
  id: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  bg: string;
  en: string;
}

/** Which languages a mode draws, in the order they stack. */
export function languagesFor(mode: SubtitleMode): SubtitleLanguage[] {
  if (mode === 'bg') return ['bg'];
  if (mode === 'en') return ['en'];
  if (mode === 'both') return ['bg', 'en'];
  return [];
}

export function cueText(cue: SubtitleCue, language: SubtitleLanguage): string {
  return (language === 'bg' ? cue.bg : cue.en).trim();
}

/** True when the mode needs text the cues do not have yet. */
export function modeNeedsLanguage(cues: SubtitleCue[], language: SubtitleLanguage): boolean {
  return cues.some((cue) => cueText(cue, language).length === 0);
}

// --- styles ---------------------------------------------------------------

export type SubtitleStyleId = 'clean' | 'modern' | 'bold-social' | 'minimal' | 'bilingual';
export type SubtitleBackdrop = 'none' | 'panel' | 'band' | 'highlight';

export interface SubtitleStyle {
  id: SubtitleStyleId;
  label: string;
  blurb: string;
  /** CSS font weight. */
  weight: number;
  /** Multiplier on the layout's base subtitle size. */
  sizeScale: number;
  uppercase: boolean;
  tracking: number;
  backdrop: SubtitleBackdrop;
  textColor: string;
  backdropColor: string;
  backdropAlpha: number;
  /** Fill behind a single word / the second language, depending on the style. */
  highlightColor: string;
  /** Stroke width around the glyphs, in design-space pixels. 0 for none. */
  outline: number;
  /** Drop-shadow blur. 0 for none. */
  shadow: number;
  /** Size of the second language relative to the first, in bilingual mode. */
  secondaryScale: number;
}

/**
 * Five presets.
 *
 * Every one of them keeps the text readable over an arbitrary photo — that is the
 * whole job of the backdrop / outline / shadow settings. "Minimal" is the lightest
 * and still carries a shadow, because a subtitle that vanishes over a bright sky is
 * worse than one that is slightly heavier than you wanted.
 */
export const SUBTITLE_STYLES: SubtitleStyle[] = [
  {
    id: 'clean',
    label: 'Clean',
    blurb: 'White text on a soft dark panel',
    weight: 500,
    sizeScale: 1,
    uppercase: false,
    tracking: 0,
    backdrop: 'panel',
    textColor: '#FFFFFF',
    backdropColor: '#0B0E12',
    backdropAlpha: 0.58,
    highlightColor: '#F0873C',
    outline: 0,
    shadow: 18,
    secondaryScale: 0.82,
  },
  {
    id: 'modern',
    label: 'Modern',
    blurb: 'Per-line pill, tight tracking, no outline',
    weight: 600,
    sizeScale: 1.02,
    uppercase: false,
    tracking: -0.4,
    backdrop: 'highlight',
    textColor: '#FFFFFF',
    backdropColor: '#12161B',
    backdropAlpha: 0.72,
    highlightColor: '#F0873C',
    outline: 0,
    shadow: 12,
    secondaryScale: 0.8,
  },
  {
    id: 'bold-social',
    label: 'Bold Social',
    blurb: 'Heavy caps with a thick outline, built for Reels',
    weight: 800,
    sizeScale: 1.12,
    uppercase: true,
    tracking: 0.6,
    backdrop: 'none',
    textColor: '#FFFFFF',
    backdropColor: '#000000',
    backdropAlpha: 0.4,
    highlightColor: '#F0873C',
    outline: 9,
    shadow: 22,
    secondaryScale: 0.78,
  },
  {
    id: 'minimal',
    label: 'Minimal',
    blurb: 'Text only, held up by a shadow',
    weight: 500,
    sizeScale: 0.94,
    uppercase: false,
    tracking: 0,
    backdrop: 'none',
    textColor: '#F2ECE0',
    backdropColor: '#000000',
    backdropAlpha: 0.3,
    highlightColor: '#F0873C',
    outline: 0,
    shadow: 26,
    secondaryScale: 0.84,
  },
  {
    id: 'bilingual',
    label: 'Bilingual',
    blurb: 'Bulgarian in white, English in accent underneath',
    weight: 600,
    sizeScale: 0.96,
    uppercase: false,
    tracking: 0,
    backdrop: 'band',
    textColor: '#FFFFFF',
    backdropColor: '#0B0E12',
    backdropAlpha: 0.62,
    highlightColor: '#F0A268',
    outline: 0,
    shadow: 14,
    secondaryScale: 0.86,
  },
];

export function styleById(id: SubtitleStyleId): SubtitleStyle {
  return SUBTITLE_STYLES.find((style) => style.id === id) ?? SUBTITLE_STYLES[0];
}

export type SubtitlePosition = 'top' | 'middle' | 'bottom';
export type SubtitleAlign = 'left' | 'center' | 'right';

export const SUBTITLE_POSITIONS: Array<{ id: SubtitlePosition; label: string }> = [
  { id: 'top', label: 'Top' },
  { id: 'middle', label: 'Middle' },
  { id: 'bottom', label: 'Bottom' },
];

export const SUBTITLE_ALIGNMENTS: Array<{ id: SubtitleAlign; label: string }> = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
];

export const SUBTITLE_TEXT_COLORS = ['#FFFFFF', '#F2ECE0', '#FFD9A8', '#0D0F12', '#F0873C'];
export const SUBTITLE_BACKDROP_COLORS = ['#0B0E12', '#232A31', '#B4502C', '#2E4136', '#F2ECE0'];
export const SUBTITLE_HIGHLIGHT_COLORS = ['#F0873C', '#FFD9A8', '#7FD1B9', '#8AB4F8', '#FFFFFF'];

export interface SubtitleSettings {
  mode: SubtitleMode;
  styleId: SubtitleStyleId;
  /** Multiplier on the style's size. 0.75 – 1.5. */
  size: number;
  position: SubtitlePosition;
  align: SubtitleAlign;
  /** `null` means "whatever the style says". */
  textColor: string | null;
  backdropColor: string | null;
  backdropAlpha: number | null;
  highlightColor: string | null;
}

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  mode: 'none',
  styleId: 'clean',
  size: 1,
  position: 'bottom',
  align: 'center',
  textColor: null,
  backdropColor: null,
  backdropAlpha: null,
  highlightColor: null,
};

/** A style with the user's overrides folded in — what the renderer actually reads. */
export interface ResolvedSubtitleStyle extends SubtitleStyle {
  /** Final size multiplier: style scale × user size. */
  scale: number;
}

export function resolveSubtitleStyle(settings: SubtitleSettings): ResolvedSubtitleStyle {
  const base = styleById(settings.styleId);
  return {
    ...base,
    textColor: settings.textColor ?? base.textColor,
    backdropColor: settings.backdropColor ?? base.backdropColor,
    backdropAlpha: settings.backdropAlpha ?? base.backdropAlpha,
    highlightColor: settings.highlightColor ?? base.highlightColor,
    scale: base.sizeScale * Math.min(1.5, Math.max(0.75, settings.size)),
  };
}

// --- timing ---------------------------------------------------------------

/** Short model-made holes should not make a subtitle visibly blink off mid-sentence. */
export const MAX_SHORT_CUE_GAP_SECONDS = 0.45;
const CUE_HANDOFF_GAP_SECONDS = 0.01;

/** The cue covering `elapsed`, or null in a gap. Cues are assumed sorted. */
export function cueAt(cues: SubtitleCue[], elapsed: number): SubtitleCue | null {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (elapsed < cue.start) return null;
    if (elapsed <= cue.end) return cue;
  }
  return null;
}

/**
 * Sort, clamp to the clip, and stop cues from overlapping.
 *
 * Transcription comes back in segments that were sent separately, so their
 * timestamps can bump into each other by a few milliseconds at the seams. Two cues
 * on screen at once is the visible symptom, so it is fixed once, here, rather than
 * defended against in the renderer.
 */
export function normaliseCues(cues: SubtitleCue[], duration: number): SubtitleCue[] {
  const sorted = [...cues]
    .map((cue) => ({
      ...cue,
      bg: cue.bg.trim(),
      en: cue.en.trim(),
      start: Math.max(0, Math.min(cue.start, duration)),
      end: Math.max(0, Math.min(cue.end, duration)),
    }))
    .filter((cue) => cue.end > cue.start + 0.05 && (cue.bg || cue.en))
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      const boundary = Math.max(sorted[i - 1].start + 0.2, sorted[i].start);
      sorted[i - 1] = { ...sorted[i - 1], end: boundary };
      sorted[i] = { ...sorted[i], start: boundary };
    }
  }

  // Speech models commonly leave a 0.1–0.4 s hole between neighbouring pieces of
  // one sentence. Close only those short holes, leaving real pauses blank. Because
  // this changes the cue data itself, Preview, MP4, SRT and VTT all stay identical.
  for (let i = 0; i < sorted.length - 1; i++) {
    const cue = sorted[i];
    const next = sorted[i + 1];
    const gap = next.start - cue.end;
    if (gap > CUE_HANDOFF_GAP_SECONDS && gap <= MAX_SHORT_CUE_GAP_SECONDS) {
      sorted[i] = {
        ...cue,
        end: Math.min(duration, next.start - CUE_HANDOFF_GAP_SECONDS),
      };
    }
  }
  return sorted.filter((cue) => cue.end > cue.start + 0.05);
}

/** Total seconds of speech the cues cover — shown as a sanity check in the UI. */
export function cueCoverage(cues: SubtitleCue[]): number {
  return cues.reduce((total, cue) => total + (cue.end - cue.start), 0);
}

// --- sidecar files --------------------------------------------------------

function stamp(seconds: number, separator: ',' | '.'): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

function linesFor(cue: SubtitleCue, mode: SubtitleMode): string[] {
  return languagesFor(mode)
    .map((language) => cueText(cue, language))
    .filter((text) => text.length > 0);
}

export function toSrt(cues: SubtitleCue[], mode: SubtitleMode): string {
  const blocks: string[] = [];
  let index = 1;
  for (const cue of cues) {
    const lines = linesFor(cue, mode);
    if (lines.length === 0) continue;
    blocks.push(
      `${index}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${lines.join('\n')}`,
    );
    index++;
  }
  return blocks.join('\n\n') + '\n';
}

export function toVtt(cues: SubtitleCue[], mode: SubtitleMode): string {
  const blocks: string[] = ['WEBVTT'];
  for (const cue of cues) {
    const lines = linesFor(cue, mode);
    if (lines.length === 0) continue;
    blocks.push(`${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n') + '\n';
}
