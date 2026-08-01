'use client';

import { VIDEO_FORMATS, describeFormat, type FormatId, type VideoFormat } from '@/lib/layout';
import {
  WATERMARK_NAME,
  WATERMARK_POSITIONS,
  WATERMARK_PREFIX,
  type WatermarkPosition,
  type WatermarkSettings,
} from '@/lib/watermark';
import { CheckIcon, FrameIcon, StampIcon } from './Icons';

interface FormatPanelProps {
  format: VideoFormat;
  watermark: WatermarkSettings;
  onFormat: (id: FormatId) => void;
  onWatermark: (settings: WatermarkSettings) => void;
}

/** Miniature of each shape, so the choice reads as a picture rather than a ratio. */
function Thumb({ format, active }: { format: VideoFormat; active: boolean }) {
  const tall = format.height > format.width;
  const width = tall ? 26 : format.width === format.height ? 38 : 46;
  const height = Math.round((width * format.height) / format.width);
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: 50, height: 50 }}
      aria-hidden="true"
    >
      <span
        className="block rounded-[3px] border transition-colors"
        style={{
          width,
          height,
          borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.3)',
          background: active ? 'rgba(240,135,60,0.14)' : 'rgba(242,236,224,0.04)',
        }}
      />
    </span>
  );
}

export default function FormatPanel({
  format,
  watermark,
  onFormat,
  onWatermark,
}: FormatPanelProps) {
  const positions: Array<{ id: WatermarkPosition; label: string }> = [...WATERMARK_POSITIONS];

  return (
    <section className="panel" aria-labelledby="step-format">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">06</span>
        <h2 id="step-format" className="font-display text-2xl leading-none">
          Format &amp; branding
        </h2>
      </header>

      <div className="mb-3 flex items-center gap-2.5 text-ash">
        <FrameIcon className="h-4 w-4" />
        <span className="label-mono">Video size</span>
      </div>

      <ul className="grid gap-2.5 sm:grid-cols-3" role="list">
        {VIDEO_FORMATS.map((candidate) => {
          const active = candidate.id === format.id;
          return (
            <li key={candidate.id}>
              <button
                type="button"
                onClick={() => onFormat(candidate.id)}
                aria-pressed={active}
                className="flex h-full w-full items-center gap-3 border px-3.5 py-3 text-left transition-colors"
                style={{
                  borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                  background: active ? 'rgba(240,135,60,0.07)' : 'rgba(242,236,224,0.02)',
                }}
              >
                <Thumb format={candidate} active={active} />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-bone">{candidate.label}</span>
                  <span className="label-mono mt-1 block normal-case tracking-normal">
                    {describeFormat(candidate)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="label-mono mt-3 normal-case tracking-normal leading-relaxed">
        {format.blurb}. Subtitles, the waveform and the watermark are re-laid out for this
        shape and stay clear of the platform&apos;s own buttons.
      </p>

      {/* Watermark */}
      <div className="mt-7 border-t border-bone/10 pt-6">
        <div className="mb-4 flex items-center gap-2.5 text-ash">
          <StampIcon className="h-4 w-4" />
          <span className="label-mono">Watermark</span>
        </div>

        {/* The mark is mandatory in the free version, so this states it rather than
            offering it: there is no control here that can clear it, and
            `WatermarkSettings` has no field one could set. Only the corner is a choice. */}
        <div className="flex items-start gap-3 text-sm">
          <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-ember" />
          <span>
            <span className="text-bone">
              Every video carries &ldquo;{WATERMARK_PREFIX} {WATERMARK_NAME}&rdquo;
            </span>
            <span className="label-mono mt-1 block normal-case tracking-normal">
              A small soundwave mark in the corner, inside the safe area, burned into the
              exported file — not just the preview. Pick the corner it sits in.
            </span>
          </span>
        </div>

        <div
          className="mt-5 grid grid-cols-2 gap-2.5"
          role="group"
          aria-label="Watermark position"
        >
          {positions.map(({ id, label }) => {
            const active = watermark.position === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onWatermark({ ...watermark, position: id })}
                aria-pressed={active}
                className="flex items-center justify-between gap-2 border px-3.5 py-2.5 text-sm transition-colors"
                style={{
                  borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                  background: active ? 'rgba(240,135,60,0.07)' : 'transparent',
                  color: active ? 'var(--color-ember)' : 'var(--color-ash)',
                }}
              >
                {label}
                {active && <CheckIcon className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
