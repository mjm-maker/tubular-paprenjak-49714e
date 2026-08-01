'use client';

import { formatBytes } from '@/lib/audio';
import { DEFAULT_FORMAT, describeFormat, type VideoFormat } from '@/lib/layout';
import { AlertIcon, CheckIcon, DownloadIcon, LinkIcon, ShareIcon } from './Icons';

interface SharePanelProps {
  videoUrl: string | null;
  sizeBytes: number;
  filename: string;
  format?: VideoFormat;
  /** Whether this browser will hand the actual MP4 to the OS share sheet. */
  fileSharingSupported: boolean;
  notice: string | null;
  onShare: () => void;
  onCopyLink: () => void;
  onDownload: () => void;
}

/**
 * Three controls, all of which do exactly what they say: hand the real MP4 to the
 * device's share sheet, save it, or copy the GLASKO address.
 *
 * There is no Instagram / Facebook / TikTok button, because a web page cannot upload a
 * video to any of them — such a button could only open a page with a link on it, which
 * would look like posting and would not be.
 */
export default function SharePanel({
  videoUrl,
  sizeBytes,
  filename,
  format = DEFAULT_FORMAT,
  fileSharingSupported,
  notice,
  onShare,
  onCopyLink,
  onDownload,
}: SharePanelProps) {
  return (
    <section className="panel pb-2" aria-labelledby="step-share">
      <header className="mb-6 flex items-baseline gap-3">
        {/* No step number: this is the second half of step 07, shown once the file exists. */}
        <h2 id="step-share" className="font-display text-2xl leading-none">
          Share your GLASKO
        </h2>
        <span className="label-mono ml-auto">Ready</span>
      </header>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {videoUrl && (
          <div className="w-full max-w-[188px] shrink-0 self-center border border-bone/12 bg-ink-raised p-1.5 sm:self-start">
            {/* The finished MP4 itself, not the canvas preview — what you see here is
                byte-for-byte the file that gets shared or downloaded, sound included. */}
            <video
              src={videoUrl}
              controls
              playsInline
              preload="metadata"
              className={`block ${format.aspectClass} w-full bg-ink object-cover`}
            />
            <p className="label-mono mt-1.5 px-1 pb-0.5 normal-case tracking-normal">
              {formatBytes(sizeBytes)} · {describeFormat(format)}
            </p>
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-3">
          <button
            type="button"
            onClick={onShare}
            className="btn-primary"
            title={
              fileSharingSupported
                ? 'Open your device share sheet with the MP4 attached'
                : 'This browser cannot attach files to the share sheet'
            }
          >
            <ShareIcon className="h-4 w-4" />
            Share video
          </button>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <button type="button" onClick={onDownload} className="btn-ghost">
              <DownloadIcon className="h-4 w-4" />
              Download MP4
            </button>
            <button type="button" onClick={onCopyLink} className="btn-ghost">
              <LinkIcon className="h-4 w-4" />
              Copy GLASKO link
            </button>
          </div>

          {notice && (
            <p
              className="flex items-start gap-2 text-sm text-ash"
              role="status"
              aria-live="polite"
            >
              <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
              <span>{notice}</span>
            </p>
          )}

          {fileSharingSupported ? (
            <p className="label-mono normal-case tracking-normal leading-relaxed">
              Share video opens your phone&apos;s own share menu with the MP4 attached — pick
              Instagram, TikTok, WhatsApp or anything else installed.
            </p>
          ) : (
            <div className="flex items-start gap-3 border border-bone/12 px-4 py-3.5 text-sm text-ash">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                This browser cannot pass a file to another app, so Share falls back to a
                download. Save the MP4 and upload it from your gallery or files app.
              </p>
            </div>
          )}

          <p className="label-mono normal-case tracking-normal break-all">{filename}</p>
        </div>
      </div>
    </section>
  );
}
