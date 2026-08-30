'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertIcon,
  BroadcastIcon,
  CloseIcon,
  FacebookIcon,
  InstagramIcon,
} from './Icons';

export type LivePlatform = 'facebook' | 'instagram';

interface LiveBroadcastProps {
  format: string;
  hasAudio: boolean;
  previewing: boolean;
  platform: LivePlatform;
  disabled?: boolean;
  onPlatform: (platform: LivePlatform) => void;
  onPreview: (platform: LivePlatform) => void;
  onStopPreview: () => void;
}

const PLATFORMS: Array<{
  id: LivePlatform;
  label: string;
  detail: string;
  icon: typeof FacebookIcon;
}> = [
  {
    id: 'facebook',
    label: 'Facebook Live',
    detail: 'Page or profile',
    icon: FacebookIcon,
  },
  {
    id: 'instagram',
    label: 'Instagram Live',
    detail: 'Professional account',
    icon: InstagramIcon,
  },
];

/**
 * The first, deliberately honest live-broadcast surface.
 *
 * It lets the user choose a destination and inspect the live treatment on the real
 * GLASKO canvas. It does not claim to publish: a browser cannot push an RTMP stream
 * straight to either network, so the final start control stays a later, authenticated
 * integration with a secure relay or the platforms' official APIs.
 */
export default function LiveBroadcast({
  format,
  hasAudio,
  previewing,
  platform,
  disabled = false,
  onPlatform,
  onPreview,
  onStopPreview,
}: LiveBroadcastProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  const selected = PLATFORMS.find((item) => item.id === platform) ?? PLATFORMS[0];

  const dialog = open ? (
    <div
      className="fixed inset-0 z-[80] grid place-items-end bg-ink/85 p-0 backdrop-blur-sm sm:place-items-center sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) setOpen(false);
      }}
    >
      <section
        className="max-h-[92dvh] w-full overflow-y-auto border border-bone/14 bg-ink-raised px-5 pb-6 pt-5 shadow-[0_30px_90px_rgba(0,0,0,0.65)] sm:max-w-lg sm:px-7 sm:pb-7 sm:pt-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="flex items-start gap-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-clay/70 bg-clay/[0.14] text-clay">
            <BroadcastIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="label-mono text-clay">Live studio · Preview</p>
            <h2 id={titleId} className="mt-2 font-display text-3xl leading-tight">
              Broadcast your GLASKO canvas
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-bone/14 text-ash transition-colors hover:border-bone/40 hover:text-bone"
            aria-label="Close live setup"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <p className="mt-4 text-sm leading-relaxed text-ash">
          The canvas in Preview is the picture your viewers will see. Choose where the
          broadcast is going, then test the live layout before connecting an account.
        </p>

        <fieldset className="mt-6">
          <legend className="label-mono mb-3">Destination</legend>
          <div className="grid grid-cols-2 gap-3">
            {PLATFORMS.map((item) => {
              const Icon = item.icon;
              const active = item.id === platform;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onPlatform(item.id)}
                  className="min-w-0 border px-3 py-4 text-left transition-colors"
                  style={{
                    borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                    background: active ? 'rgba(240,135,60,0.11)' : 'rgba(242,236,224,0.025)',
                  }}
                  aria-pressed={active}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-bone">
                    <Icon className="h-4 w-4" />
                    <span className="truncate">{item.label}</span>
                  </span>
                  <span className="label-mono mt-2 block normal-case tracking-normal">
                    {item.detail}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 border border-bone/12 bg-ink/45 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-bone">Live picture</p>
              <p className="mt-1 text-sm text-ash">GLASKO canvas · {format}</p>
            </div>
            <span className="label-mono shrink-0 text-ember">{selected.label}</span>
          </div>
          <div className="mt-3 hairline" />
          <p className="mt-3 text-sm leading-relaxed text-ash">
            {hasAudio
              ? 'Your current voice and music will play with the canvas during this layout test.'
              : 'The layout can be tested now. Record or upload a voice first if you also want sound.'}
          </p>
        </div>

        <div className="mt-5 flex items-start gap-3 border border-bone/12 px-4 py-3.5 text-sm text-ash">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-ember" />
          <p>
            This is a safe preview and does not publish anything. A real broadcast will need a
            secure Facebook or Instagram connection before the final Start Live button is enabled.
          </p>
        </div>

        <div className="mt-5 grid gap-2.5 sm:grid-cols-[1fr_auto]">
          <button
            type="button"
            onClick={() => {
              if (previewing) onStopPreview();
              else onPreview(platform);
              setOpen(false);
            }}
            className="btn-primary"
          >
            <BroadcastIcon className="h-4 w-4" />
            {previewing ? 'Stop live preview' : 'Preview live layout'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn-ghost sm:w-auto sm:px-6">
            Close
          </button>
        </div>
      </section>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="mt-4 flex w-full items-center gap-3 border border-clay/65 bg-clay/[0.1] px-4 py-3.5 text-left transition-colors hover:border-clay hover:bg-clay/[0.16] disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-clay/15 text-clay">
          <span className="absolute inset-0 rounded-full border border-clay/45 motion-safe:animate-ping" />
          <BroadcastIcon className="relative h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-bone">
            {previewing ? 'Live preview is on' : 'Go live'}
          </span>
          <span className="label-mono mt-1 block normal-case tracking-normal">
            Facebook · Instagram
          </span>
        </span>
        <span className="label-mono shrink-0 text-clay">{previewing ? 'Preview' : 'Set up'}</span>
      </button>

      {mounted && dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
