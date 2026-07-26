'use client';

import { useMemo, useRef, useState } from 'react';
import { formatDuration } from '@/lib/audio';
import {
  MUSIC_FORMAT_LABEL,
  MUSIC_LIBRARY,
  MUSIC_UPLOAD_ACCEPT,
  POPULATED_CATEGORIES,
  describeMusicFileProblem,
  musicCoverage,
  type MusicCategory,
  type MusicTrack,
  type SelectedMusic,
} from '@/lib/music';
import { MUSIC_FADE_SECONDS } from '@/lib/mix';
import {
  CheckIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';

interface MusicPanelProps {
  selected: SelectedMusic | null;
  /** Track currently being fetched and decoded, if any. */
  loadingId: string | null;
  /** Id of the track being auditioned, or null. Owned by the page. */
  auditionId: string | null;
  /** Length of the voice recording; 0 when none is loaded yet. */
  voiceDuration: number;
  voiceVolume: number;
  musicVolume: number;
  onSelect: (track: MusicTrack) => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onAudition: (id: string, src: string) => void;
  onVoiceVolume: (value: number) => void;
  onMusicVolume: (value: number) => void;
  onError: (message: string) => void;
}

type Filter = MusicCategory | 'All';

function VolumeSlider({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-bone">
          {label}
        </label>
        <span className="label-mono tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="mt-2.5 w-full"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="label-mono mt-1.5 normal-case tracking-normal">
        {hint}
      </p>
    </div>
  );
}

export default function MusicPanel({
  selected,
  loadingId,
  auditionId,
  voiceDuration,
  voiceVolume,
  musicVolume,
  onSelect,
  onUpload,
  onRemove,
  onAudition,
  onVoiceVolume,
  onMusicVolume,
  onError,
}: MusicPanelProps) {
  const [filter, setFilter] = useState<Filter>('All');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tracks = useMemo(
    () => (filter === 'All' ? MUSIC_LIBRARY : MUSIC_LIBRARY.filter((t) => t.category === filter)),
    [filter],
  );

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = describeMusicFileProblem(file);
    if (problem) {
      onError(problem);
      return;
    }
    onUpload(file);
  };

  const coverage = selected ? musicCoverage(selected.duration, voiceDuration) : null;
  const filters: Filter[] = ['All', ...POPULATED_CATEGORIES];

  return (
    <section className="panel" aria-labelledby="step-music">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">04</span>
        <h2 id="step-music" className="font-display text-2xl leading-none">
          Background music
        </h2>
        <span className="label-mono ml-auto">Optional</span>
      </header>

      {/* Selected track */}
      {selected ? (
        <div className="mb-6 border border-ember/40 bg-ember/[0.07] px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm text-bone">{selected.title}</p>
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                {selected.category} · {formatDuration(selected.duration)} · {selected.artist}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => onAudition(selected.id, selected.url)}
                className="chip !px-3 !py-2.5 text-ash hover:text-bone"
                aria-label={auditionId === selected.id ? 'Pause this track' : 'Play this track'}
              >
                {auditionId === selected.id ? (
                  <PauseIcon className="h-4 w-4" />
                ) : (
                  <PlayIcon className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="chip !px-3 !py-2.5 text-ash hover:text-bone"
                aria-label="Remove the background music"
              >
                <TrashIcon />
              </button>
            </div>
          </div>

          {voiceDuration > 0 && coverage && (
            <p className="label-mono mt-3 normal-case tracking-normal">
              {coverage.mode === 'loop'
                ? `Loops ${coverage.loops}× to cover ${formatDuration(voiceDuration)} of voice`
                : coverage.mode === 'trim'
                  ? `Trimmed to ${formatDuration(voiceDuration)} to match the voice`
                  : `Matches the ${formatDuration(voiceDuration)} voice exactly`}
              {' · '}
              {MUSIC_FADE_SECONDS.toFixed(1)}s fade in and out
            </p>
          )}
          <p className="label-mono mt-1.5 normal-case tracking-normal">
            License: {selected.license}
          </p>
        </div>
      ) : (
        <p className="mb-6 text-sm leading-relaxed text-ash">
          Add a music bed under your voice, or leave this out — the video exports fine either way.
        </p>
      )}

      {/* Volume */}
      <div className="mb-7 grid gap-5 border-y border-bone/10 py-6 sm:grid-cols-2 sm:gap-7">
        <VolumeSlider
          id="voice-volume"
          label="Voice volume"
          hint="Your recording"
          value={voiceVolume}
          onChange={onVoiceVolume}
        />
        <VolumeSlider
          id="music-volume"
          label="Music volume"
          hint={selected ? 'Under the voice' : 'Applies once a track is picked'}
          value={musicVolume}
          onChange={onMusicVolume}
        />
      </div>

      {/* Category filter */}
      <div className="mb-4 flex flex-wrap gap-2">
        {filters.map((name) => {
          const active = filter === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => setFilter(name)}
              aria-pressed={active}
              className="rounded-full border px-3.5 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors"
              style={{
                borderColor: active ? 'var(--color-ember)' : 'rgba(242,236,224,0.16)',
                color: active ? 'var(--color-ember)' : 'var(--color-ash)',
                background: active ? 'rgba(240,135,60,0.1)' : 'transparent',
              }}
            >
              {name}
            </button>
          );
        })}
      </div>

      {/* Track cards */}
      <ul className="grid gap-2.5 sm:grid-cols-2" role="list">
        {tracks.map((track) => {
          const isSelected = selected?.id === track.id;
          const isAuditioning = auditionId === track.id;
          const isLoading = loadingId === track.id;
          return (
            <li key={track.id}>
              <div
                className="flex h-full items-center gap-3 border px-3.5 py-3 transition-colors"
                style={{
                  borderColor: isSelected ? 'var(--color-ember)' : 'rgba(242,236,224,0.12)',
                  background: isSelected ? 'rgba(240,135,60,0.07)' : 'rgba(242,236,224,0.02)',
                }}
              >
                <button
                  type="button"
                  onClick={() => onAudition(track.id, track.src)}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-bone/20 text-bone transition-colors hover:border-bone/50"
                  aria-label={`${isAuditioning ? 'Pause' : 'Preview'} ${track.title}`}
                >
                  {isAuditioning ? (
                    <PauseIcon className="h-3.5 w-3.5" />
                  ) : (
                    <PlayIcon className="h-3.5 w-3.5" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-bone">{track.title}</p>
                  <p className="label-mono mt-1 normal-case tracking-normal">
                    {track.category} · {formatDuration(track.duration)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => onSelect(track)}
                  disabled={isLoading || isSelected}
                  className="chip shrink-0 !px-3 !py-2 disabled:opacity-100"
                  style={
                    isSelected
                      ? { borderColor: 'var(--color-ember)', color: 'var(--color-ember)' }
                      : undefined
                  }
                  aria-label={isSelected ? `${track.title} selected` : `Use ${track.title}`}
                >
                  {isLoading ? (
                    <SpinnerIcon className="h-3.5 w-3.5" />
                  ) : isSelected ? (
                    <CheckIcon className="h-3.5 w-3.5" />
                  ) : (
                    'Select'
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Upload */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loadingId === 'upload'}
          className="chip justify-center py-3 sm:w-auto"
        >
          {loadingId === 'upload' ? (
            <SpinnerIcon className="h-4 w-4" />
          ) : (
            <UploadIcon className="h-4 w-4" />
          )}
          {loadingId === 'upload' ? 'Reading track' : 'Upload your own music'}
        </button>
        <p className="label-mono normal-case tracking-normal">{MUSIC_FORMAT_LABEL}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept={MUSIC_UPLOAD_ACCEPT}
          onChange={handleFile}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      <div className="mt-6 flex items-start gap-3 border-t border-bone/10 pt-5 text-sm text-ash">
        <MusicIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="leading-relaxed">
          Every built-in track was synthesised for GLASKO and is released into the public domain
          (CC0), so there is nothing to clear before you post. If you upload your own music, make
          sure you have the right to use it — platforms mute or block videos over copyrighted audio.
        </p>
      </div>
    </section>
  );
}
