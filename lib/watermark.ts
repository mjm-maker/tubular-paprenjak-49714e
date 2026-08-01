/**
 * The "Made with GLASKO" mark.
 *
 * In the free version the mark is mandatory: every preview frame and every exported
 * MP4 carries it, and there is no interface anywhere for turning it off. That is
 * enforced by the types rather than by discipline — `WatermarkSettings`, the shape the
 * page keeps in state and the panel edits, holds only the corner. It cannot express
 * "off", so no control can set it.
 *
 * The capability still exists for a future paid plan, in exactly one place.
 * `watermarkFor()` is that place: it is the only function that decides `enabled`, and
 * the renderer only ever reads the flag it returns. When GLASKO PRO exists, a paying
 * user passes `pro = true` here and nothing else in the app changes.
 */

export type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export const WATERMARK_POSITIONS: Array<{ id: WatermarkPosition; label: string }> = [
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
];

/** Everything the user gets to choose about the mark — which corner, and no more. */
export interface WatermarkSettings {
  position: WatermarkPosition;
}

/**
 * What the renderer reads. `enabled` exists only on this resolved shape, and only
 * `watermarkFor()` produces it, so a component cannot hand the renderer a cleared
 * mark without going through the one decision that owns that.
 */
export interface ResolvedWatermark extends WatermarkSettings {
  enabled: boolean;
}

export const DEFAULT_WATERMARK: WatermarkSettings = {
  position: 'bottom-right',
};

/** Small caption above the wordmark. */
export const WATERMARK_PREFIX = 'Made with';
/** The wordmark itself, always set heavier than the prefix. */
export const WATERMARK_NAME = 'GLASKO';

/**
 * Resolve what actually gets drawn, given the user's corner and their plan.
 *
 * `pro` is threaded through as a plain boolean rather than read from anywhere: there
 * is no account system yet, so the only honest thing to do is leave the parameter in
 * place, default it to `false`, and let a future sign-in flow pass `true`. Nothing in
 * the app calls it with `true` today, which is why the mark is always on.
 */
export function watermarkFor(settings: WatermarkSettings, pro = false): ResolvedWatermark {
  return { ...settings, enabled: !pro };
}
