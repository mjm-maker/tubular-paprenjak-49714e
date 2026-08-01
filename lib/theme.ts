/** Design tokens shared by the interface and the rendered video frames. */

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;

export const palette = {
  ink: '#0D0F12',
  ink2: '#14181D',
  slate: '#232A31',
  ash: '#6E7681',
  bone: '#F2ECE0',
  ember: '#F0873C',
  clay: '#B4502C',
  moss: '#2E4136',
} as const;

export type BackgroundChoice =
  | { kind: 'solid'; id: string; label: string; color: string }
  | { kind: 'gradient'; id: string; label: string; from: string; to: string; angle: number }
  | { kind: 'image'; id: 'image'; label: string; src: string };

export const SOLID_BACKGROUNDS: Extract<BackgroundChoice, { kind: 'solid' }>[] = [
  { kind: 'solid', id: 'ink', label: 'Ink', color: '#0D0F12' },
  { kind: 'solid', id: 'slate', label: 'Slate', color: '#232A31' },
  { kind: 'solid', id: 'clay', label: 'Clay', color: '#B4502C' },
  { kind: 'solid', id: 'moss', label: 'Moss', color: '#2E4136' },
  { kind: 'solid', id: 'bone', label: 'Bone', color: '#F2ECE0' },
];

export const GRADIENT_BACKGROUNDS: Extract<BackgroundChoice, { kind: 'gradient' }>[] = [
  { kind: 'gradient', id: 'dusk', label: 'Ember Dusk', from: '#2B1410', to: '#D06A2A', angle: 145 },
  { kind: 'gradient', id: 'nightfall', label: 'Nightfall', from: '#0A0D11', to: '#2A3A46', angle: 160 },
  { kind: 'gradient', id: 'sandstone', label: 'Sandstone', from: '#F0E2C6', to: '#C08A55', angle: 135 },
  { kind: 'gradient', id: 'thicket', label: 'Thicket', from: '#0F1512', to: '#3D5A45', angle: 150 },
];

export const DEFAULT_BACKGROUND = GRADIENT_BACKGROUNDS[0];

/**
 * `none` is a real choice, not an absence: the renderer skips the animation layer
 * entirely for it rather than drawing something invisible, so the frame is the
 * background plus subtitles, chrome and watermark and nothing else.
 *
 * `pulse` is the quiet end of the same scale — one thin line, held at roughly a third
 * of the opacity of the other two, for a video where the picture window or the
 * headline is meant to carry the frame and the voice only needs proof of life.
 */
export type AnimationKind = 'wave' | 'bars' | 'pulse' | 'none';

export const ANIMATIONS: Array<{ id: AnimationKind; label: string; blurb: string }> = [
  { id: 'wave', label: 'Waveform', blurb: 'Scrolling wave with a centre playhead' },
  { id: 'bars', label: 'Audio bars', blurb: 'Frequency bars reacting to each syllable' },
  { id: 'pulse', label: 'Minimal pulse', blurb: 'One soft line, barely there' },
  { id: 'none', label: 'No animation', blurb: 'Background, subtitles and voice only' },
];

// --- colour maths ---------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace('#', '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const int = Number.parseInt(value, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface RenderTheme {
  /** Primary foreground for the animation and wordmark. */
  fg: string;
  /** Accent used for the played portion and progress fill. */
  accent: string;
  /** True when the background is light and needs dark ink on top. */
  light: boolean;
}

/** Pick foreground + accent colours that stay legible on the chosen background. */
export function themeFor(background: BackgroundChoice): RenderTheme {
  if (background.kind === 'image') {
    // Uploaded images get a scrim, so light-on-dark is always safe.
    return { fg: palette.bone, accent: palette.ember, light: false };
  }

  const base =
    background.kind === 'solid'
      ? background.color
      : // Average the two stops for a rough sense of the overall tone.
        averageHex(background.from, background.to);

  const light = luminance(base) > 0.36;
  const fg = light ? palette.ink : palette.bone;
  // Fall back to plain foreground when ember would disappear into the background.
  const accent = contrast(palette.ember, base) >= 1.9 ? palette.ember : fg;
  return { fg, accent, light };
}

function averageHex(a: string, b: string): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round((x + y) / 2);
  return `#${[mix(ar, br), mix(ag, bg), mix(ab, bb)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}
