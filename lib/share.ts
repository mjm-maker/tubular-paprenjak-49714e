/**
 * Download and native-share plumbing.
 *
 * There is no automatic posting to TikTok / Instagram / Facebook / YouTube here, and
 * there cannot be: those platforms only accept programmatic uploads through their
 * official APIs with a reviewed app and an authenticated user. What the Web Share API
 * does give us is the real OS share sheet, which lists whichever of those apps are
 * installed — the user picks one and the video is handed over. Everything else falls
 * back to a plain download plus instructions.
 *
 * There are deliberately no per-network buttons. A web share endpoint cannot carry a
 * video, so a Facebook or Instagram button here could only ever open a page with a
 * link in it — which looks like posting the video and is not. The OS share sheet is
 * the one route that really hands the MP4 to those apps, so that is the only one
 * offered, with a download beside it.
 */

export type ShareOutcome = 'shared' | 'dismissed' | 'unsupported' | 'too-large' | 'failed';

export const SHARE_TITLE = 'GLASKO';
export const SHARE_TEXT = 'Created with GLASKO';

/** Saves a blob to the downloads folder. `false` means the browser refused. */
export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this browser can share a video file at all (not just a link).
 * Probed with a tiny stand-in of the same type, because `canShare` inspects the type.
 */
export function canShareVideoFiles(type = 'video/mp4'): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    const extension = type.includes('webm') ? 'webm' : 'mp4';
    const probe = new File([new Uint8Array(1)], `glasko.${extension}`, { type });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Whether this browser can share this exact file.
 *
 * Checked synchronously and separately from `shareVideoFile` so a click handler can
 * decide to open a web share page instead — `window.open` after an `await` has usually
 * lost its user activation and gets blocked.
 */
export function canShareFile(file: File): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Why this particular file cannot be shared, when it cannot.
 *
 * If the browser happily accepts a one-byte stand-in of the same type but refuses the
 * real thing, the file itself is the problem — in practice its size. Returns `null`
 * when the file can be shared.
 */
export function describeShareBlock(file: File): 'unsupported' | 'too-large' | null {
  if (canShareFile(file)) return null;
  return canShareVideoFiles(file.type) ? 'too-large' : 'unsupported';
}

/** `glasko-video-2026-07-31.mp4` — the local date, which is the one the user recognises. */
export function buildFilename(extension = 'mp4'): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `glasko-video-${stamp}.${extension}`;
}

export async function shareVideoFile(file: File, text: string): Promise<ShareOutcome> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'unsupported';
  }
  const blocked = describeShareBlock(file);
  if (blocked) return blocked;

  try {
    await navigator.share({ files: [file], title: SHARE_TITLE, text });
    return 'shared';
  } catch (error) {
    // Tapping outside the share sheet rejects with AbortError; that is not a failure.
    if ((error as Error)?.name === 'AbortError') return 'dismissed';
    return 'failed';
  }
}

/**
 * The GLASKO address to hand to other people.
 *
 * Deliberately without the query string: "Copy GLASKO link" shares the app, not
 * whatever state this particular tab happens to be in.
 */
export function siteUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}`;
}

/** Clipboard write with a fallback for browsers that gate the async clipboard API. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}
