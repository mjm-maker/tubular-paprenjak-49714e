'use client';

import { useMemo, useState } from 'react';
import { formatDuration } from '@/lib/audio';
import {
  LANGUAGE_LABEL,
  SUBTITLE_ALIGNMENTS,
  SUBTITLE_BACKDROP_COLORS,
  SUBTITLE_HIGHLIGHT_COLORS,
  SUBTITLE_MODES,
  SUBTITLE_POSITIONS,
  SUBTITLE_STYLES,
  SUBTITLE_TEXT_COLORS,
  cueCoverage,
  languagesFor,
  resolveSubtitleStyle,
  type SubtitleCue,
  type SubtitleLanguage,
  type SubtitleMode,
  type SubtitleSettings,
} from '@/lib/subtitles';
import { AlertIcon, CaptionIcon, CheckIcon, DownloadIcon, TrashIcon } from './Icons';

/** What the page tells the panel about the transcription job. */
export type SubtitleStatus =
  | { phase: 'idle' }
  | { phase: 'working'; detail: string; ratio: number }
  | { phase: 'ready' }
  | { phase: 'error'; message: string; setup?: boolean };

interface SubtitlePanelProps {
  settings: SubtitleSettings;
  cues: SubtitleCue[];
  /** Language the transcriber reported, once there is a transcript. */
  detected: SubtitleLanguage | null;
  status: SubtitleStatus;
  /** True once a voice recording is loaded. */
  ready: boolean;
  duration: number;
  onSettings: (next: SubtitleSettings) => void;
  onGenerate: () => void;
  onCancel: () => void;
  onEditCue: (id: string, language: SubtitleLanguage, text: string) => void;
  onClear: () => void;
  onDownload: (kind: 'srt' | 'vtt') => void;
}

function Swatches({
  label,
  colors,
  value,
  fallback,
  onChange,
}: {
  label: string;
  colors: string[];
  /** `null` means "follow the style". */
  value: string | null;
  fallback: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <div>
      <span className="label-mono">{label}</span>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          className="rounded-full border px-3 py-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] transition-colors"
          style={{
            borderColor: value === null ? 'var(--color-ember)' : 'rgba(242,236,224,0.16)',
            color: value === null ? 'var(--color-ember)' : 'var(--color-ash)',
          }}
        >
          Style
        </button>
        {colors.map((color) => {
          const active = (value ?? fallback).toLowerCase() === color.toLowerCase() && value !== null;
          return (
            <button
              key={color}
              type="button"
              onClick={() => onChange(color)}
              aria-pressed={active}
              aria-label={`${label}: ${color}`}
              className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110"
              style={{
                background: color,
                borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.28)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function SubtitlePanel({
  settings,
  cues,
  detected,
  status,
  ready,
  duration,
  onSettings,
  onGenerate,
  onCancel,
  onEditCue,
  onClear,
  onDownload,
}: SubtitlePanelProps) {
  const [editing, setEditing] = useState(false);
  const resolved = useMemo(() => resolveSubtitleStyle(settings), [settings]);
  const languages = languagesFor(settings.mode);
  const working = status.phase === 'working';
  const hasCues = cues.length > 0;

  const patch = (next: Partial<SubtitleSettings>) => onSettings({ ...settings, ...next });

  const setMode = (mode: SubtitleMode) => {
    patch({
      mode,
      // The bilingual preset exists for the stacked layout; switching into "Both"
      // picks it up unless the user has deliberately chosen something else.
      styleId: mode === 'both' && settings.styleId === 'clean' ? 'bilingual' : settings.styleId,
    });
  };

  return (
    <section className="panel" aria-labelledby="step-subtitles">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">05</span>
        <h2 id="step-subtitles" className="font-display text-2xl leading-none">
          Subtitles
        </h2>
        <span className="label-mono ml-auto">Optional</span>
      </header>

      {/* Language mode */}
      <ul className="grid gap-2.5 sm:grid-cols-2" role="list">
        {SUBTITLE_MODES.map((mode) => {
          const active = settings.mode === mode.id;
          return (
            <li key={mode.id}>
              <button
                type="button"
                onClick={() => setMode(mode.id)}
                aria-pressed={active}
                className="flex h-full w-full items-center justify-between gap-3 border px-3.5 py-3 text-left transition-colors"
                style={{
                  borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                  background: active ? 'rgba(240,135,60,0.07)' : 'rgba(242,236,224,0.02)',
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-bone">{mode.label}</span>
                  <span className="label-mono mt-1 block normal-case tracking-normal">
                    {mode.blurb}
                  </span>
                </span>
                {active && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-ember" />}
              </button>
            </li>
          );
        })}
      </ul>

      {settings.mode !== 'none' && (
        <>
          {/* Transcription */}
          <div className="mt-6 border-y border-bone/10 py-6">
            {working ? (
              <div className="space-y-4" role="status" aria-live="polite">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-bone">{status.detail}</span>
                  <span className="label-mono tabular-nums">
                    {Math.round(status.ratio * 100)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-bone/10">
                  <div
                    className="progress-shimmer h-full rounded-full transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.max(3, status.ratio * 100)}%` }}
                  />
                </div>
                <button type="button" onClick={onCancel} className="btn-ghost">
                  Stop
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={onGenerate}
                    disabled={!ready}
                    className={hasCues ? 'btn-ghost' : 'btn-primary'}
                  >
                    {hasCues ? (
                      'Transcribe again'
                    ) : (
                      <>
                        <CaptionIcon className="h-4 w-4" />
                        Generate subtitles
                      </>
                    )}
                  </button>
                  {hasCues && (
                    <button
                      type="button"
                      onClick={onClear}
                      className="chip justify-center sm:w-auto"
                      aria-label="Remove the subtitles"
                    >
                      <TrashIcon />
                      Clear
                    </button>
                  )}
                </div>

                {hasCues ? (
                  <p className="label-mono normal-case tracking-normal">
                    {cues.length} cues · {formatDuration(cueCoverage(cues))} of{' '}
                    {formatDuration(duration)} covered
                    {detected ? ` · recognised as ${LANGUAGE_LABEL[detected]}` : ''}
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-ash">
                    {ready
                      ? 'Your voice is sent to the transcription service for this step only — nothing is stored, and the rest of GLASKO still runs entirely in this tab.'
                      : 'Record or upload a voice message first.'}
                  </p>
                )}
              </div>
            )}

            {status.phase === 'error' && (
              <div
                className={`mt-4 flex items-start gap-3 border px-4 py-3.5 text-sm ${
                  status.setup ? 'border-bone/14 bg-bone/[0.04]' : 'border-clay/60 bg-clay/[0.12]'
                }`}
                role="alert"
              >
                <AlertIcon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${status.setup ? 'text-ember' : 'text-clay'}`}
                />
                <p className="text-bone">{status.message}</p>
              </div>
            )}
          </div>

          {/* Cue editor */}
          {hasCues && (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setEditing((value) => !value)}
                  aria-expanded={editing}
                  className="label-mono underline decoration-bone/25 underline-offset-4 hover:text-bone"
                >
                  {editing ? 'Hide the text' : 'Edit the text'}
                </button>
                <div className="flex gap-2.5">
                  <button type="button" onClick={() => onDownload('srt')} className="chip">
                    <DownloadIcon className="h-3.5 w-3.5" />
                    .srt
                  </button>
                  <button type="button" onClick={() => onDownload('vtt')} className="chip">
                    <DownloadIcon className="h-3.5 w-3.5" />
                    .vtt
                  </button>
                </div>
              </div>

              {editing && (
                <ul className="mt-4 max-h-[22rem] space-y-2.5 overflow-y-auto pr-1" role="list">
                  {cues.map((cue) => (
                    <li key={cue.id} className="border border-bone/10 bg-bone/[0.02] px-3.5 py-3">
                      <p className="label-mono tabular-nums">
                        {formatDuration(cue.start)} → {formatDuration(cue.end)}
                      </p>
                      <div className="mt-2 space-y-2">
                        {(languages.length > 0 ? languages : (['bg'] as SubtitleLanguage[])).map(
                          (language) => (
                            <label key={language} className="block">
                              <span className="sr-only">
                                {LANGUAGE_LABEL[language]} text for this cue
                              </span>
                              <textarea
                                value={language === 'bg' ? cue.bg : cue.en}
                                onChange={(event) =>
                                  onEditCue(cue.id, language, event.target.value)
                                }
                                rows={2}
                                spellCheck={false}
                                lang={language}
                                placeholder={LANGUAGE_LABEL[language]}
                                className="w-full resize-y border border-bone/12 bg-ink px-3 py-2 text-sm text-bone outline-none focus:border-ember/60"
                              />
                            </label>
                          ),
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Style */}
          <div className="mt-7 border-t border-bone/10 pt-6">
            <span className="label-mono">Style</span>
            <ul className="mt-3 grid gap-2.5 sm:grid-cols-2" role="list">
              {SUBTITLE_STYLES.map((style) => {
                const active = settings.styleId === style.id;
                return (
                  <li key={style.id}>
                    <button
                      type="button"
                      onClick={() => patch({ styleId: style.id })}
                      aria-pressed={active}
                      className="flex h-full w-full items-center justify-between gap-3 border px-3.5 py-3 text-left transition-colors"
                      style={{
                        borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                        background: active ? 'rgba(240,135,60,0.07)' : 'rgba(242,236,224,0.02)',
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-bone">{style.label}</span>
                        <span className="label-mono mt-1 block normal-case tracking-normal">
                          {style.blurb}
                        </span>
                      </span>
                      {active && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-ember" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Size, position, alignment */}
          <div className="mt-7 space-y-6 border-t border-bone/10 pt-6">
            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="subtitle-size" className="text-sm text-bone">
                  Text size
                </label>
                <span className="label-mono tabular-nums">
                  {Math.round(settings.size * 100)}%
                </span>
              </div>
              <input
                id="subtitle-size"
                type="range"
                min={75}
                max={150}
                step={5}
                value={Math.round(settings.size * 100)}
                onChange={(event) => patch({ size: Number(event.target.value) / 100 })}
                className="mt-2.5 w-full"
              />
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                Scales with the video format. Long lines wrap to two lines and shrink to fit
                rather than run over the waveform.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div role="group" aria-label="Subtitle position">
                <span className="label-mono">Position</span>
                <div className="mt-2.5 flex gap-2">
                  {SUBTITLE_POSITIONS.map(({ id, label }) => {
                    const active = settings.position === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => patch({ position: id })}
                        aria-pressed={active}
                        className="flex-1 border px-3 py-2 text-sm transition-colors"
                        style={{
                          borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                          background: active ? 'rgba(240,135,60,0.07)' : 'transparent',
                          color: active ? 'var(--color-ember)' : 'var(--color-ash)',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div role="group" aria-label="Subtitle alignment">
                <span className="label-mono">Alignment</span>
                <div className="mt-2.5 flex gap-2">
                  {SUBTITLE_ALIGNMENTS.map(({ id, label }) => {
                    const active = settings.align === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => patch({ align: id })}
                        aria-pressed={active}
                        className="flex-1 border px-3 py-2 text-sm transition-colors"
                        style={{
                          borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                          background: active ? 'rgba(240,135,60,0.07)' : 'transparent',
                          color: active ? 'var(--color-ember)' : 'var(--color-ash)',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Colours */}
            <div className="grid gap-6 sm:grid-cols-2">
              <Swatches
                label="Text colour"
                colors={SUBTITLE_TEXT_COLORS}
                value={settings.textColor}
                fallback={resolved.textColor}
                onChange={(value) => patch({ textColor: value })}
              />
              <Swatches
                label="Background"
                colors={SUBTITLE_BACKDROP_COLORS}
                value={settings.backdropColor}
                fallback={resolved.backdropColor}
                onChange={(value) => patch({ backdropColor: value })}
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="subtitle-backdrop" className="text-sm text-bone">
                  Background strength
                </label>
                <span className="label-mono tabular-nums">
                  {settings.backdropAlpha === null
                    ? 'Style'
                    : `${Math.round(settings.backdropAlpha * 100)}%`}
                </span>
              </div>
              <input
                id="subtitle-backdrop"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round((settings.backdropAlpha ?? resolved.backdropAlpha) * 100)}
                onChange={(event) => patch({ backdropAlpha: Number(event.target.value) / 100 })}
                className="mt-2.5 w-full"
              />
              {settings.backdropAlpha !== null && (
                <button
                  type="button"
                  onClick={() => patch({ backdropAlpha: null })}
                  className="label-mono mt-1.5 underline decoration-bone/25 underline-offset-4 hover:text-bone"
                >
                  Back to the style default
                </button>
              )}
            </div>

            <Swatches
              label="Highlight"
              colors={SUBTITLE_HIGHLIGHT_COLORS}
              value={settings.highlightColor}
              fallback={resolved.highlightColor}
              onChange={(value) => patch({ highlightColor: value })}
            />
          </div>

          <div className="mt-6 flex items-start gap-3 border-t border-bone/10 pt-5 text-sm text-ash">
            <CaptionIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="leading-relaxed">
              Subtitles are drawn into the video itself, so they show up on every platform
              whether or not the viewer turns captions on. Two lines at most at a time, kept
              inside the area Instagram, TikTok and Facebook leave clear.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
