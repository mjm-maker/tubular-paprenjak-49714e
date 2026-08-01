/**
 * The GLASKO logo as a drawable image.
 *
 * The header renders `public/glasko-logo.png` through an `<img>`; the video frame
 * needs the same artwork as a `CanvasImageSource` so `drawFrame` can paint it, which
 * is what this module provides. One file, one loader, so the mark on the page, the
 * mark in the preview and the mark in the exported MP4 cannot drift apart.
 *
 * Loading is async and drawing is not, so the logo travels in `RenderSpec.logo` and
 * the renderer keeps its original text wordmark as the fallback. A slow network, a
 * blocked request or a non-browser context (the subtitle-sync script) therefore
 * costs the frame nothing: it draws the wordmark it always drew.
 */

export const BRAND_LOGO_SRC = '/glasko-logo.png';

/**
 * The artwork plus the intrinsic size it was decoded at. The size is read from the
 * file rather than hard-coded so the aspect ratio is always the real one — replacing
 * the PNG with a differently proportioned version can never stretch it.
 */
export interface BrandLogo {
  image: CanvasImageSource;
  width: number;
  height: number;
}

let pending: Promise<BrandLogo | null> | null = null;

/**
 * Load the logo once per tab. Resolves to `null` instead of rejecting: a missing
 * logo is a fallback, never an error the user has to see or a broken export.
 */
export function loadBrandLogo(): Promise<BrandLogo | null> {
  if (pending) return pending;
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(null);
  }

  pending = new Promise<BrandLogo | null>((resolve) => {
    const element = new Image();
    element.decoding = 'async';
    element.onload = () => {
      const width = element.naturalWidth;
      const height = element.naturalHeight;
      if (!width || !height) {
        resolve(null);
        return;
      }
      // Rasterise before the first frame asks for it, so the logo never lands
      // half-decoded in an exported frame. `decode` is optional; `onload` alone is
      // enough for correctness, it just may cost a frame the first time.
      const ready = element.decode?.().catch(() => undefined) ?? Promise.resolve();
      ready.then(() => resolve({ image: element, width, height }));
    };
    element.onerror = () => resolve(null);
    element.src = BRAND_LOGO_SRC;
  });

  return pending;
}

interface TintEntry {
  source: CanvasImageSource;
  layer: CanvasImageSource;
}

const tintCache = new Map<string, TintEntry>();

/**
 * The logo as a flat silhouette in one colour, for backgrounds its own colours
 * cannot survive.
 *
 * The artwork is warm bone lettering with a gold waveform — made for a dark frame,
 * and close to invisible on Bone or Sandstone. The text wordmark this replaced solved
 * that by taking its colour from the theme, and a single-colour lockup is the
 * conventional answer for a logo on a background its palette does not suit. Only the
 * colour changes: the alpha channel is reused untouched, so the shape, the
 * proportions and the antialiased edges are exactly those of the original file.
 *
 * Returns the untinted artwork when there is no canvas to build the silhouette in.
 */
export function tintedBrandLogo(logo: BrandLogo, color: string): CanvasImageSource {
  const cached = tintCache.get(color);
  if (cached && cached.source === logo.image) return cached.layer;

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(logo.width, logo.height);
  } else if (typeof document !== 'undefined') {
    const element = document.createElement('canvas');
    element.width = logo.width;
    element.height = logo.height;
    canvas = element;
  } else {
    return logo.image;
  }

  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return logo.image;

  ctx.drawImage(logo.image, 0, 0, logo.width, logo.height);
  // `source-in` keeps the logo's own alpha and replaces every colour under it.
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, logo.width, logo.height);

  tintCache.set(color, { source: logo.image, layer: canvas });
  return canvas;
}
