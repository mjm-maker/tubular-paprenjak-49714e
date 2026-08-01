/**
 * The "Made with GLASKO" mark.
 *
 * Kept in its own module for one reason: it has to be removable. GLASKO PRO is a
 * placeholder today, but when it exists, dropping the watermark for a paying user
 * must be a single decision made in one place rather than a hunt through the
 * renderer. `watermarkFor()` is that decision — the renderer only ever reads the
 * `enabled` flag it returns, so nothing else needs to change.
 */

export type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export const WATERMARK_POSITIONS: Array<{ id: WatermarkPosition; label: string }> = [
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
];

export interface WatermarkSettings {
  enabled: boolean;
  position: WatermarkPosition;
}

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: true,
  position: 'bottom-right',
};

/** Small caption above the wordmark. */
export const WATERMARK_PREFIX = 'Made with';
/** The wordmark itself, always set heavier than the prefix. */
export const WATERMARK_NAME = 'GLASKO';

/**
 * Resolve what actually gets drawn, given the user's choice and their plan.
 *
 * `pro` is threaded through as a plain boolean rather than read from anywhere:
 * there is no account system yet, so the only honest thing to do is leave the
 * parameter in place, default it to `false`, and let a future sign-in flow pass
 * `true`. Nothing in the app calls it with `true` today.
 */
export function watermarkFor(settings: WatermarkSettings, pro = false): WatermarkSettings {
  if (pro) return { ...settings, enabled: false };
  return settings;
}
