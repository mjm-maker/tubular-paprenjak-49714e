'use client';

import { formatBytes, formatDuration } from '@/lib/audio';
import { describeAudioProof, describePipeline, type EncodeResult, type EncodeStage } from '@/lib/encode';
import { DEFAULT_FORMAT, describeFormat, type VideoFormat } from '@/lib/layout';
import { AlertIcon, CheckIcon } from './Icons';

/**
 * `stage` is the encoder's own progress; `label` is the plain-language step the page
 * wants shown, which can start before the encoder does ("Preparing audio" while the
 * mix is rendering, "Generating subtitles" if the transcript is still running).
 */
export type ExportState =
  | { phase: 'idle' }
  | { phase: 'working'; stage: EncodeStage; ratio: number; detail: string; label?: string }
  | { phase: 'done'; result: EncodeResult; filename: string }
  | { phase: 'error'; message: string };

interface ExportPanelProps {
  ready: boolean;
  duration: number;
  format?: VideoFormat;
  state: ExportState;
  onGenerate: () => void;
  onCancel: () => void;
}

const STAGE_LABEL: Record<EncodeStage, string> = {
  render: 'Rendering video',
  record: 'Rendering video',
  convert: 'Preparing MP4',
  package: 'Preparing MP4',
  verify: 'Checking the sound',
};

export default function ExportPanel({
  ready,
  duration,
  format = DEFAULT_FORMAT,
  state,
  onGenerate,
  onCancel,
}: ExportPanelProps) {
  const working = state.phase === 'working';

  return (
    <section className="panel pb-2" aria-labelledby="step-export">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">07</span>
        <h2 id="step-export" className="font-display text-2xl leading-none">
          Export
        </h2>
      </header>

      {working ? (
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm text-bone">
              {state.label ?? STAGE_LABEL[state.stage]}
              <span className="text-ash"> · {state.detail}</span>
            </span>
            <span className="label-mono tabular-nums">{Math.round(state.ratio * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bone/10">
            <div
              className="progress-shimmer h-full rounded-full transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(2, state.ratio * 100)}%` }}
            />
          </div>
          <button type="button" onClick={onCancel} className="btn-ghost">
            Cancel export
          </button>
        </div>
      ) : state.phase === 'done' ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 border border-ember/40 bg-ember/[0.08] px-4 py-3.5">
            <CheckIcon className="mt-0.5 h-4 w-4 text-ember" />
            <div className="min-w-0 text-sm">
              <p className="text-bone">Ready to share — {formatBytes(state.result.blob.size)}</p>
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                {state.result.width} × {state.result.height} · {formatDuration(duration)} ·{' '}
                {describePipeline(state.result.pipeline)} ·{' '}
                {(state.result.elapsedMs / 1000).toFixed(1)}s to build
              </p>
              {/* The one thing worth stating outright, because silent video is the
                  failure that looks like a success. */}
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                {describeAudioProof(state.result.audio)}
              </p>
            </div>
          </div>

          {/* Download, share and copy link all live in the section directly below, so
              there is one place that owns the finished file. */}
          <button
            type="button"
            onClick={onGenerate}
            className="label-mono underline decoration-bone/25 underline-offset-4 hover:text-bone"
          >
            Rebuild with current settings
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <button type="button" onClick={onGenerate} disabled={!ready} className="btn-primary">
            Generate video
          </button>
          <p className="label-mono normal-case tracking-normal">
            {ready
              ? `Builds a ${formatDuration(duration)} ${describeFormat(format)} MP4 in your browser.`
              : 'Add a voice message first.'}
          </p>
        </div>
      )}

      {state.phase === 'error' && (
        <div
          className="mt-4 flex items-start gap-3 border border-clay/60 bg-clay/[0.12] px-4 py-3.5 text-sm"
          role="alert"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-clay" />
          <p className="text-bone">{state.message}</p>
        </div>
      )}

      <div className="mt-7 space-y-3 border-t border-bone/10 pt-6">
        <p className="label-mono">Where it works</p>
        <p className="text-sm leading-relaxed text-ash">
          The file is a {describeFormat(format)} MP4 with H.264 video and stereo AAC audio at 48 or
          44.1 kHz — the format TikTok, Instagram, Facebook, YouTube, WhatsApp and Telegram all
          accept. GLASKO decodes the finished file and checks the audio is really audible before
          handing it over, because a silent upload is the one failure that looks like a success.
          Posting itself happens in those apps: automatic publishing would require each
          platform&apos;s official upload API and an authenticated account, which this app does
          not use.
        </p>
      </div>
    </section>
  );
}
