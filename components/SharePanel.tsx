'use client';

import { formatBytes } from '@/lib/audio';
import type { SocialTarget } from '@/lib/share';
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  FacebookIcon,
  LinkIcon,
  LinkedInIcon,
  ShareIcon,
  TelegramIcon,
  WhatsAppIcon,
  XIcon,
} from './Icons';

interface SharePanelProps {
  videoUrl: string | null;
  sizeBytes: number;
  filename: string;
  /** Whether this browser will hand the actual MP4 to the OS share sheet. */
  fileSharingSupported: boolean;
  notice: string | null;
  onShare: () => void;
  onSocial: (target: SocialTarget) => void;
  onCopyLink: () => void;
  onDownload: () => void;
}

const NETWORKS: { target: SocialTarget; label: string; Icon: typeof FacebookIcon }[] = [
  { target: 'facebook', label: 'Facebook', Icon: FacebookIcon },
  { target: 'whatsapp', label: 'WhatsApp', Icon: WhatsAppIcon },
  { target: 'telegram', label: 'Telegram', Icon: TelegramIcon },
  { target: 'x', label: 'X', Icon: XIcon },
  { target: 'linkedin', label: 'LinkedIn', Icon: LinkedInIcon },
];

export default function SharePanel({
  videoUrl,
  sizeBytes,
  filename,
  fileSharingSupported,
  notice,
  onShare,
  onSocial,
  onCopyLink,
  onDownload,
}: SharePanelProps) {
  return (
    <section className="panel pb-2" aria-labelledby="step-share">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">06</span>
        <h2 id="step-share" className="font-display text-2xl leading-none">
          Share your GLASKO
        </h2>
      </header>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {videoUrl && (
          <div className="w-full max-w-[168px] shrink-0 self-center border border-bone/12 bg-ink-raised p-1.5 sm:self-start">
            {/* The finished MP4 itself, not the canvas preview — what you see here is
                byte-for-byte the file that gets shared or downloaded. */}
            <video
              src={videoUrl}
              controls
              playsInline
              preload="metadata"
              className="block aspect-[9/16] w-full bg-ink object-cover"
            />
            <p className="label-mono mt-1.5 px-1 pb-0.5 normal-case tracking-normal">
              {formatBytes(sizeBytes)}
            </p>
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-3">
          <div className="grid gap-2.5 sm:grid-cols-2">
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
              Share
            </button>
            <button type="button" onClick={onDownload} className="btn-ghost">
              <DownloadIcon className="h-4 w-4" />
              Download MP4
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {NETWORKS.map(({ target, label, Icon }) => (
              <button
                key={target}
                type="button"
                onClick={() => onSocial(target)}
                className="chip justify-center"
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
            <button type="button" onClick={onCopyLink} className="chip justify-center">
              <LinkIcon className="h-4 w-4" />
              Copy link
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

          {!fileSharingSupported && (
            <div className="flex items-start gap-3 border border-bone/12 px-4 py-3.5 text-sm text-ash">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                Download your GLASKO video, then upload it to your social media account. This
                browser cannot pass the file straight to another app.
              </p>
            </div>
          )}

          <p className="label-mono normal-case tracking-normal break-all">{filename}</p>
        </div>
      </div>
    </section>
  );
}
