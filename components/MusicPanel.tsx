'use client';

import { useRef } from 'react';
import { formatDuration } from '@/lib/audio';
import {
  MUSIC_FORMAT_LABEL,
  MUSIC_UPLOAD_ACCEPT,
  describeMusicFileProblem,
  musicCoverage,
  normaliseVolume,
  type SelectedMusic,
} from '@/lib/music';
import { MUSIC_FADE_SECONDS } from '@/lib/mix';
import {
  CheckIcon,
  MusicIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  SpinnerIcon,
  TrashIcon,
  UploadIcon,
} from './Icons';

interface MusicPanelProps {
  selected: SelectedMusic | null;
  loadingId: string | null;
  auditionId: string | null;
  voiceDuration: number;
  voiceVolume: number;
  musicVolume: number;
  onUpload: (file: File) => void;
  onRemove: () => void;
  onAudition: (id: string, src: string) => void;
  onVoiceVolume: (value: number) => void;
  onMusicVolume: (value: number) => void;
  onError: (message: string) => void;
}

/** A touch-friendly slider with buttons as a reliable fallback on phones. */
function VolumeSlider({
  id,
  label,
  hint,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const level = normaliseVolume(value);
  const percent = Math.round(level * 100);
  const update = (next: number) => onChange(normaliseVolume(next));
  const readInput = (event: React.FormEvent<HTMLInputElement>) => {
    update(Number(event.currentTarget.value) / 100);
  };

  return (
    <div className={disabled ? 'opacity-55' : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-bone">
          {label}
        </label>
        <output htmlFor={id} className="label-mono tabular-nums">
          {percent}%
        </output>
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => update(level - 0.05)}
          disabled={disabled || level <= 0}
          className="chip grid h-10 w-10 shrink-0 place-items-center !p-0 text-lg disabled:opacity-30"
          aria-label={`Lower ${label.toLowerCase()}`}
        >
          −
        </button>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={disabled}
          onInput={readInput}
          onChange={readInput}
          className="volume-range min-w-0 flex-1 disabled:cursor-not-allowed"
          aria-describedby={`${id}-hint`}
          aria-valuetext={`${percent} percent`}
        />
        <button
          type="button"
          onClick={() => update(level + 0.05)}
          disabled={disabled || level >= 1}
          className="chip grid h-10 w-10 shrink-0 place-items-center !p-0 text-lg disabled:opacity-30"
          aria-label={`Raise ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>

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
  onUpload,
  onRemove,
  onAudition,
  onVoiceVolume,
  onMusicVolume,
  onError,
}: MusicPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const uploading = loadingId === 'upload';

  return (
    <section className="panel" aria-labelledby="step-music">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">06</span>
        <h2 id="step-music" className="font-display text-2xl leading-none">
          Background music
        </h2>
        <span className="label-mono ml-auto">Optional</span>
      </header>

      {selected ? (
        <div className="mb-6 border border-ember/40 bg-ember/[0.07] px-4 py-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm text-bone">{selected.title}</p>
              <p className="label-mono mt-1.5 normal-case tracking-normal">
                Your song · {formatDuration(selected.duration)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => onAudition(selected.id, selected.url)}
                className="chip !px-3 !py-2.5 text-ash hover:text-bone"
                aria-label={auditionId === selected.id ? 'Pause your song' : 'Play your song'}
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
        </div>
      ) : (
        <p className="mb-6 text-sm leading-relaxed text-ash">
          Leave the video voice-only, or upload one song from your device.
        </p>
      )}

      <div className="mb-7 grid gap-5 border-y border-bone/10 py-6 sm:grid-cols-2 sm:gap-7">
        <VolumeSlider
          id="voice-volume"
          label="Voice volume"
          hint={voiceDuration > 0 ? 'Changes Preview immediately' : 'Record or upload a voice first'}
          value={voiceVolume}
          disabled={voiceDuration <= 0}
          onChange={onVoiceVolume}
        />
        <VolumeSlider
          id="music-volume"
          label="Music volume"
          hint={selected ? 'Changes the song and Preview immediately' : 'Upload a song first'}
          value={musicVolume}
          disabled={!selected}
          onChange={onMusicVolume}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className="flex items-center gap-3 border px-3.5 py-3 transition-colors"
          style={{
            borderColor: selected ? 'rgba(242,236,224,0.12)' : 'var(--color-ember)',
            background: selected ? 'rgba(242,236,224,0.02)' : 'rgba(240,135,60,0.07)',
          }}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-bone/15 text-ash">
            <MuteIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-bone">No music</p>
            <p className="label-mono mt-1 normal-case tracking-normal">Voice only</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            disabled={!selected}
            className="chip shrink-0 !px-3 !py-2 disabled:opacity-100"
            style={
              selected
                ? undefined
                : { borderColor: 'var(--color-ember)', color: 'var(--color-ember)' }
            }
            aria-label={selected ? 'Export with no background music' : 'No music selected'}
          >
            {selected ? 'Select' : <CheckIcon className="h-3.5 w-3.5" />}
          </button>
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-3 border border-bone/15 bg-bone/[0.02] px-3.5 py-3 text-left transition-colors hover:border-bone/35 disabled:opacity-60"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-bone/15 text-bone">
            {uploading ? <SpinnerIcon className="h-4 w-4" /> : <UploadIcon className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-bone">
              {uploading ? 'Reading your song' : selected ? 'Replace your song' : 'Upload your song'}
            </span>
            <span className="label-mono mt-1 block normal-case tracking-normal">
              {MUSIC_FORMAT_LABEL}
            </span>
          </span>
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={MUSIC_UPLOAD_ACCEPT}
        onChange={handleFile}
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="mt-6 flex items-start gap-3 border-t border-bone/10 pt-5 text-sm text-ash">
        <MusicIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="leading-relaxed">
          Use a song you own or have permission to use. Facebook, Instagram and other platforms
          may mute a video that contains copyrighted music.
        </p>
      </div>
    </section>
  );
}
