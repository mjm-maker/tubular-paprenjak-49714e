'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_DURATION_SECONDS,
  MAX_UPLOAD_BYTES,
  MicRecorder,
  describeMicError,
  formatBytes,
  formatDuration,
  micRecordingSupported,
} from '@/lib/audio';
import Autocue from './Autocue';
import { MicIcon, SpinnerIcon, StopIcon, TrashIcon, UploadIcon } from './Icons';

export type AudioOrigin = 'mic' | 'file';

interface SourcePanelProps {
  source: { label: string; duration: number; origin: AudioOrigin; bytes: number } | null;
  decoding: boolean;
  onAudio: (blob: Blob, label: string, origin: AudioOrigin) => void;
  onClear: () => void;
  onError: (message: string) => void;
}

export default function SourcePanel({
  source,
  decoding,
  onAudio,
  onClear,
  onError,
}: SourcePanelProps) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [micSupported, setMicSupported] = useState(true);
  const recorderRef = useRef<MicRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMicSupported(micRecordingSupported());
    return () => recorderRef.current?.cancel();
  }, []);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setRecording(false);
    setLevel(0);
    try {
      const blob = await recorder.stop();
      if (blob.size === 0) {
        onError('Nothing was captured. Check that the right microphone is selected.');
        return;
      }
      onAudio(blob, 'Voice memo', 'mic');
    } catch (error) {
      onError(describeMicError(error));
    }
  }, [onAudio, onError]);

  const start = useCallback(async (): Promise<boolean> => {
    if (starting || recording) return false;
    setStarting(true);
    setElapsed(0);
    const recorder = new MicRecorder({
      onLevel: setLevel,
      onElapsed: (seconds) => {
        setElapsed(seconds);
        // Hard stop at the ceiling instead of letting the export fail later.
        if (seconds >= MAX_DURATION_SECONDS) void stop();
      },
      onError: (error) => onError(error.message),
    });
    try {
      await recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      return true;
    } catch (error) {
      onError(describeMicError(error));
      return false;
    } finally {
      setStarting(false);
    }
  }, [onError, recording, starting, stop]);

  const handleFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        onError(`That file is ${formatBytes(file.size)}. Keep it under ${formatBytes(MAX_UPLOAD_BYTES)}.`);
        return;
      }
      onAudio(file, file.name, 'file');
    },
    [onAudio, onError],
  );

  const busy = decoding || starting;

  return (
    <section className="panel" aria-labelledby="step-voice">
      <header className="mb-6 flex items-baseline gap-3">
        <span className="step-index">01</span>
        <h2 id="step-voice" className="font-display text-2xl leading-none">
          Your voice
        </h2>
      </header>

      <Autocue
        canRecord={!source && !decoding && micSupported}
        microphoneAvailable={micSupported}
        recording={recording}
        starting={starting}
        elapsed={elapsed}
        level={level}
        onStart={start}
        onStop={stop}
        onError={onError}
      />

      {source ? (
        <div className="flex items-center justify-between gap-4 border border-bone/12 bg-bone/[0.03] px-4 py-3.5">
          <div className="min-w-0">
            <p className="truncate text-sm text-bone">{source.label}</p>
            <p className="label-mono mt-1.5">
              {source.origin === 'mic' ? 'Recorded' : 'Uploaded'} · {formatDuration(source.duration)}{' '}
              · {formatBytes(source.bytes)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="chip !px-3 !py-2.5 text-ash hover:text-bone"
            aria-label="Remove this audio"
          >
            <TrashIcon />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* Record */}
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={recording ? stop : () => void start()}
              disabled={busy || !micSupported}
              className="relative grid h-16 w-16 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-40"
              style={{
                borderColor: recording ? 'var(--color-ember)' : 'rgba(242,236,224,0.24)',
                background: recording ? 'rgba(240,135,60,0.16)' : 'rgba(242,236,224,0.04)',
                color: recording ? 'var(--color-ember)' : 'var(--color-bone)',
              }}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
            >
              {/* Ring driven by the live input level, so you can see the mic works. */}
              {recording && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full border border-ember"
                  style={{
                    transform: `scale(${1 + level * 0.5})`,
                    opacity: 0.15 + level * 0.55,
                    transition: 'transform 90ms linear, opacity 90ms linear',
                  }}
                />
              )}
              {starting ? <SpinnerIcon className="h-6 w-6" /> : recording ? <StopIcon className="h-5 w-5" /> : <MicIcon className="h-6 w-6" />}
            </button>
            <div>
              <p className="text-sm">
                {recording ? 'Recording' : starting ? 'Waiting for permission' : 'Record a voice message'}
              </p>
              <p className="label-mono mt-1.5 tabular-nums">
                {recording
                  ? `${formatDuration(elapsed)} · max ${formatDuration(MAX_DURATION_SECONDS)}`
                  : micSupported
                    ? 'Tap to start · tap again to stop'
                    : 'Not available in this browser'}
              </p>
            </div>
          </div>

          <span className="label-mono hidden sm:ml-auto sm:block">or</span>

          {/* Upload */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || recording}
            className="chip justify-center py-3.5 sm:w-auto"
          >
            {decoding ? <SpinnerIcon className="h-4 w-4" /> : <UploadIcon className="h-4 w-4" />}
            {decoding ? 'Reading file' : 'Upload audio file'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm,.aac,.flac"
            onChange={handleFile}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      )}
    </section>
  );
}
