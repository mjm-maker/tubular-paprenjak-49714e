'use client';

import {
  HEADLINE_ANIMATIONS,
  HEADLINE_MAX_CHARS,
  clampHeadline,
  type HeadlineSettings,
} from '@/lib/headline';
import { CheckIcon, HeadlineIcon } from './Icons';

interface HeadlinePanelProps {
  settings: HeadlineSettings;
  onSettings: (settings: HeadlineSettings) => void;
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
    background: active ? 'rgba(240,135,60,0.07)' : 'transparent',
    color: active ? 'var(--color-ember)' : 'var(--color-ash)',
  };
}

export default function HeadlinePanel({ settings, onSettings }: HeadlinePanelProps) {
  const remaining = HEADLINE_MAX_CHARS - settings.text.length;

  return (
    <section className="panel" aria-labelledby="step-headline">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">05</span>
        <h2 id="step-headline" className="font-display text-2xl leading-none">
          Topic
        </h2>
      </header>

      <p className="label-mono mb-5 normal-case tracking-normal leading-relaxed">
        One line across the top of the video saying what it is about. Off by default.
      </p>

      <div className="flex gap-2.5" role="group" aria-label="Topic line">
        {[
          { on: false, label: 'Off' },
          { on: true, label: 'On' },
        ].map(({ on, label }) => (
          <button
            key={label}
            type="button"
            onClick={() => onSettings({ ...settings, enabled: on })}
            aria-pressed={settings.enabled === on}
            className="flex flex-1 items-center justify-center gap-2 border px-3.5 py-2.5 text-sm transition-colors"
            style={chipStyle(settings.enabled === on)}
          >
            {on && <HeadlineIcon className="h-4 w-4" />}
            {label}
          </button>
        ))}
      </div>

      {settings.enabled && (
        <div className="mt-6 space-y-6">
          <div>
            <label htmlFor="headline-text" className="label-mono mb-3 block">
              Headline
            </label>
            <input
              id="headline-text"
              type="text"
              value={settings.text}
              maxLength={HEADLINE_MAX_CHARS}
              onChange={(event) =>
                onSettings({ ...settings, text: clampHeadline(event.target.value) })
              }
              placeholder="What is this video about?"
              className="w-full border border-bone/14 bg-bone/[0.03] px-3.5 py-3 text-[0.95rem] text-bone outline-none transition-colors placeholder:text-ash/70 focus:border-ember"
            />
            <p className="label-mono mt-2 normal-case tracking-normal">
              {remaining} characters left · one or two lines, kept clear of the logo and the
              picture window
            </p>
          </div>

          <div>
            <span className="label-mono mb-3 block">How it arrives</span>
            <div className="grid gap-2.5 sm:grid-cols-2" role="group" aria-label="Topic animation">
              {HEADLINE_ANIMATIONS.map(({ id, label, blurb }) => {
                const active = settings.animation === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSettings({ ...settings, animation: id })}
                    aria-pressed={active}
                    className="flex items-start justify-between gap-2 border px-3.5 py-3 text-left transition-colors"
                    style={chipStyle(active)}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm">{label}</span>
                      <span className="label-mono mt-1 block normal-case tracking-normal">
                        {blurb}
                      </span>
                    </span>
                    {active && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="label-mono mt-3 normal-case tracking-normal leading-relaxed">
              The topic arrives once and stays for the rest of the video — nothing scrolls. It is
              burned into the exported MP4, not just the preview.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
