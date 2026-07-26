'use client';

import { formatBytes, formatDuration } from '@/lib/audio';
import { describePipeline, type EncodeResult, type EncodeStage } from '@/lib/encode';
import { AlertIcon, CheckIcon } from './Icons';

export type ExportState =
  | { phase: 'idle' }
  | { phase: 'working'; stage: EncodeStage; ratio: number; detail: string }
  | { phase: 'done'; result: EncodeResult; filename: string }
  | { phase: 'error'; message: string };

interface ExportPanelProps {
  ready: boolean;
  duration: number;
  state: ExportState;
  onGenerate: () => void;
  onCancel: () => void;
}

const STAGE_LABEL: Record<EncodeStage, string> = {
  render: 'Rendering frames',
  record: 'Capturing',
  convert: 'Converting',
  package: 'Packaging',
};

export default function ExportPanel({
  ready,
  duration,
  state,
  onGenerate,
  onCancel,
}: ExportPanelProps) {
  const working = state.phase === 'working';

  return (
    <section className="panel pb-2" aria-labelledby="step-export">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">05</span>
        <h2 id="step-export" className="font-display text-2xl leading-none">
          Export
        </h2>
      </header>

      {working ? (
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-sm text-bone">
              {STAGE_LABEL[state.stage]}
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
              <p className="text-bone">Video ready — {formatBytes(state.result.blob.size)}</p>
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                {formatDuration(duration)} · {describePipeline(state.result.pipeline)} ·{' '}
                {(state.result.elapsedMs / 1000).toFixed(1)}s to build
              </p>
            </div>
          </div>

          {/* Download, native share and the per-network buttons all live in the share
              section directly below, so there is one place that owns the finished file. */}
          <button type="button" onClick={onGenerate} className="label-mono underline decoration-bone/25 underline-offset-4 hover:text-bone">
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
              ? `Builds a ${formatDuration(duration)} vertical MP4 in your browser. Nothing is uploaded to a server.`
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
          The file is a 1080 × 1920 MP4 with H.264 video and AAC audio — the format TikTok,
          Instagram Reels, Facebook Reels and YouTube Shorts all accept. Posting happens in those
          apps: GLASKO hands the finished video to your share sheet or your downloads folder, and
          you choose where it goes. Automatic publishing would require each platform&apos;s official
          upload API and an authenticated account, which this app does not use.
        </p>
      </div>
    </section>
  );
}
