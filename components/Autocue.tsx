'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration, MAX_DURATION_SECONDS } from '@/lib/audio';
import { CaptionIcon, PauseIcon, PlayIcon, StopIcon } from './Icons';

const STORAGE_KEY = 'glasko:autocue:v2';
const LEGACY_STORAGE_KEY = 'glasko:autocue:v1';
const MIN_SPEED = 20;
const MAX_SPEED = 160;
const DEFAULT_SPEED = 60;
const MIN_FONT_SIZE = 32;
const MAX_FONT_SIZE = 88;
const DEFAULT_FONT_SIZE = 52;

interface SavedAutocue {
  script: string;
  speed: number;
  fontSize: number;
}

interface AutocueProps {
  canRecord: boolean;
  /** A finished voice clip is already loaded and will be replaced only after this recording stops. */
  replacesCurrent: boolean;
  microphoneAvailable: boolean;
  recording: boolean;
  starting: boolean;
  elapsed: number;
  level: number;
  onStart: () => Promise<boolean>;
  onStop: () => Promise<void>;
  onError: (message: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function Autocue({
  canRecord,
  replacesCurrent,
  microphoneAvailable,
  recording,
  starting,
  elapsed,
  level,
  onStart,
  onStop,
  onError,
}: AutocueProps) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [script, setScript] = useState('');
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [storageReady, setStorageReady] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const countdownRunRef = useRef(0);
  const autocueRecordingRef = useRef(false);

  const words = useMemo(() => wordCount(script), [script]);
  const estimatedSeconds = Math.round((words / 135) * 60);
  const overLimit = estimatedSeconds > MAX_DURATION_SECONDS;

  useEffect(() => {
    try {
      const current = window.localStorage.getItem(STORAGE_KEY);
      const legacy = current ? null : window.localStorage.getItem(LEGACY_STORAGE_KEY);
      const raw = current ?? legacy;
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SavedAutocue>;
        if (typeof saved.script === 'string') setScript(saved.script);
        if (typeof saved.speed === 'number') {
          // v1 topped out at 60 px/s and felt almost stationary on a tall phone.
          // Migrate that setting once instead of leaving existing users stuck on the
          // old, slow value forever.
          const migrated = legacy ? saved.speed * 2 : saved.speed;
          setSpeed(clamp(Math.round(migrated), MIN_SPEED, MAX_SPEED));
        }
        if (typeof saved.fontSize === 'number') {
          setFontSize(clamp(saved.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE));
        }
      }
    } catch {
      // Autocue still works when private browsing blocks local storage.
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ script, speed, fontSize }));
    } catch {
      // Saving the script is a convenience, never a requirement.
    }
  }, [fontSize, script, speed, storageReady]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!scrolling || countdown !== null) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const delta = Math.min(80, now - previous);
      previous = now;
      scroller.scrollTop += (speed * delta) / 1000;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atEnd) {
        setScrolling(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [countdown, scrolling, speed]);

  const resetScroll = useCallback(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, []);

  const close = useCallback(async () => {
    // Do not let the modal disappear in the tiny window while the browser is still
    // opening the microphone. Once start resolves, Cancel can stop it normally.
    if (starting) return;
    countdownRunRef.current += 1;
    setCountdown(null);
    setScrolling(false);
    if (recording || autocueRecordingRef.current) await onStop();
    autocueRecordingRef.current = false;
    setReading(false);
    setOpen(false);
  }, [onStop, recording, starting]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close, open]);

  const begin = useCallback(async () => {
    if (!script.trim()) {
      onError('Paste your script into Autocue first.');
      return;
    }
    if (!microphoneAvailable) {
      onError('Microphone recording is not available in this browser.');
      return;
    }
    if (!canRecord) {
      onError('Wait for the current audio to finish loading, then start Autocue again.');
      return;
    }

    const run = countdownRunRef.current + 1;
    countdownRunRef.current = run;
    resetScroll();
    setReading(true);
    setScrolling(false);

    // Start this directly from the user's tap, before the first countdown wait.
    // iPhone Safari can refuse or indefinitely suspend microphone/audio setup once
    // that user gesture has been lost to a timer. The recorder may capture the short
    // 3-2-1 lead-in, which is preferable to an Autocue that never starts at all.
    const started = await onStart();
    if (countdownRunRef.current !== run) return;
    if (!started) {
      setReading(false);
      return;
    }
    autocueRecordingRef.current = true;

    for (let value = 3; value >= 1; value -= 1) {
      if (countdownRunRef.current !== run) return;
      setCountdown(value);
      await wait(700);
    }
    if (countdownRunRef.current !== run) return;
    setCountdown(null);

    if (countdownRunRef.current !== run) return;
    setScrolling(true);
  }, [canRecord, microphoneAvailable, onError, onStart, resetScroll, script]);

  const finish = useCallback(async () => {
    countdownRunRef.current += 1;
    setCountdown(null);
    setScrolling(false);
    await onStop();
    autocueRecordingRef.current = false;
    setReading(false);
    setOpen(false);
  }, [onStop]);

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 border border-bone/12 bg-bone/[0.025] px-4 py-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ember/35 bg-ember/[0.08] text-ember">
            <CaptionIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-bone">Autocue</p>
            <p className="mt-1 text-xs leading-relaxed text-ash">
              Paste your script, set the pace and read while GLASKO records your voice.
            </p>
            {words > 0 && (
              <p className="label-mono mt-2 normal-case tracking-normal">
                {words} words · about {formatDuration(estimatedSeconds)} · saved on this device
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={recording || starting}
          className="chip shrink-0 justify-center py-3 sm:ml-auto"
        >
          Open autocue
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex min-h-[100dvh] flex-col bg-[#050607] text-bone"
          role="dialog"
          aria-modal="true"
          aria-label="GLASKO Autocue"
        >
          {!reading ? (
            <>
              <header className="flex items-center justify-between gap-4 border-b border-bone/10 px-4 py-3 sm:px-6">
                <div>
                  <p className="label-mono text-ember">GLASKO Autocue</p>
                  <p className="mt-1 text-xs text-ash">Your script stays on this device.</p>
                </div>
                <button type="button" onClick={() => void close()} className="chip">
                  Close
                </button>
              </header>

              <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
                <label htmlFor="autocue-script" className="text-sm text-bone">
                  Paste your script
                </label>
                <textarea
                  id="autocue-script"
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  placeholder="Paste the text you want to read here…"
                  autoFocus
                  className="min-h-[42dvh] w-full resize-none rounded-[3px] border border-bone/16 bg-bone/[0.035] px-4 py-4 font-sans text-lg leading-relaxed text-bone placeholder:text-ash/70 focus:border-ember"
                />

                <div className="grid gap-5 border-y border-bone/10 py-5 sm:grid-cols-2">
                  <div>
                    <div className="flex items-baseline justify-between gap-4">
                      <label htmlFor="autocue-speed" className="text-sm text-bone">
                        Scroll speed
                      </label>
                      <span className="label-mono tabular-nums">{speed} px/s</span>
                    </div>
                    <input
                      id="autocue-speed"
                      type="range"
                      min={MIN_SPEED}
                      max={MAX_SPEED}
                      step="5"
                      value={speed}
                      onChange={(event) => setSpeed(Number(event.target.value))}
                      className="mt-3"
                    />
                    <div className="label-mono mt-1.5 flex justify-between normal-case tracking-normal">
                      <span>Slow</span>
                      <span>Fast</span>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-baseline justify-between gap-4">
                      <label htmlFor="autocue-font" className="text-sm text-bone">
                        Text size
                      </label>
                      <span className="label-mono tabular-nums">{fontSize} px</span>
                    </div>
                    <input
                      id="autocue-font"
                      type="range"
                      min={MIN_FONT_SIZE}
                      max={MAX_FONT_SIZE}
                      step="2"
                      value={fontSize}
                      onChange={(event) => setFontSize(Number(event.target.value))}
                      className="mt-3"
                    />
                    <div className="label-mono mt-1.5 flex justify-between normal-case tracking-normal">
                      <span>Smaller</span>
                      <span>Larger</span>
                    </div>
                  </div>
                </div>

                <div className="mt-auto space-y-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                  {words > 0 && (
                    <p className={`text-sm ${overLimit ? 'text-clay' : 'text-ash'}`}>
                      {words} words · roughly {formatDuration(estimatedSeconds)} at a natural pace
                      {overLimit ? ` · GLASKO records up to ${formatDuration(MAX_DURATION_SECONDS)}` : ''}
                    </p>
                  )}
                  {replacesCurrent && canRecord && (
                    <p className="text-sm text-ash">
                      Your new Autocue recording will replace the current voice clip after you press Stop.
                    </p>
                  )}
                  {!canRecord && microphoneAvailable && (
                    <p className="text-sm text-clay">Wait for the current audio to finish loading.</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void begin()}
                    disabled={!script.trim() || !canRecord || starting}
                    className="btn-primary"
                  >
                    {starting ? 'Starting microphone' : 'Start recording & autocue'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <header className="relative z-20 flex items-center justify-between gap-3 border-b border-bone/10 bg-[#050607]/95 px-3 py-3 backdrop-blur sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full bg-ember"
                    style={{
                      boxShadow: `0 0 0 ${3 + level * 8}px rgba(240,135,60,${0.08 + level * 0.18})`,
                    }}
                  />
                  <div className="min-w-0">
                    <p className="label-mono truncate text-ember">GLASKO Autocue</p>
                    <p className="mt-1 font-mono text-xs tabular-nums text-ash">
                      {recording ? `Recording · ${formatDuration(elapsed)}` : countdown ? 'Get ready' : 'Starting microphone'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void close()}
                  disabled={starting}
                  className="chip shrink-0"
                >
                  {recording ? 'Stop & close' : 'Cancel'}
                </button>
              </header>

              <div className="relative min-h-0 flex-1 overflow-hidden">
                <div
                  ref={scrollerRef}
                  className="h-full overflow-y-auto overscroll-contain px-5 sm:px-10"
                  style={{ scrollBehavior: 'auto' }}
                >
                  <div className="mx-auto max-w-4xl pb-[58vh] pt-[34vh]">
                    <p
                      className="whitespace-pre-wrap text-center font-sans font-medium leading-[1.55] tracking-[-0.01em] text-bone"
                      style={{ fontSize: `${fontSize}px` }}
                    >
                      {script.trim()}
                    </p>
                  </div>
                </div>

                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-3 top-[40%] h-px bg-ember/35 sm:inset-x-8"
                />

                {countdown !== null && (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-[#050607]/88">
                    <span className="font-display text-[8rem] leading-none text-ember">{countdown}</span>
                  </div>
                )}
              </div>

              <footer className="relative z-20 border-t border-bone/10 bg-[#050607]/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-5">
                <div className="mx-auto flex max-w-4xl items-center gap-2.5">
                  <button
                    type="button"
                    onClick={resetScroll}
                    disabled={countdown !== null}
                    className="chip shrink-0"
                  >
                    Start over
                  </button>
                  <button
                    type="button"
                    onClick={() => setScrolling((value) => !value)}
                    disabled={countdown !== null || !recording}
                    className="chip min-w-0 flex-1 justify-center"
                  >
                    {scrolling ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                    {scrolling ? 'Pause text' : 'Continue text'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void finish()}
                    disabled={!recording}
                    className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-[3px] bg-ember px-4 font-medium text-[#1a0f06] disabled:bg-ink-edge disabled:text-ash"
                  >
                    <StopIcon className="h-4 w-4" />
                    <span className="hidden sm:inline">Stop & use recording</span>
                    <span className="sm:hidden">Stop</span>
                  </button>
                </div>
                <div className="mx-auto mt-3 grid max-w-4xl gap-3 sm:grid-cols-2 sm:gap-5">
                  <div>
                    <div className="flex items-baseline justify-between gap-4">
                      <label htmlFor="autocue-live-speed" className="label-mono normal-case tracking-normal">
                        Speed
                      </label>
                      <span className="label-mono tabular-nums">{speed} px/s</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSpeed((value) => clamp(value - 10, MIN_SPEED, MAX_SPEED))}
                        className="chip h-10 !px-3 text-lg"
                        aria-label="Slow down Autocue"
                      >
                        −
                      </button>
                      <input
                        id="autocue-live-speed"
                        type="range"
                        min={MIN_SPEED}
                        max={MAX_SPEED}
                        step="5"
                        value={speed}
                        onChange={(event) => setSpeed(Number(event.target.value))}
                        className="min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => setSpeed((value) => clamp(value + 10, MIN_SPEED, MAX_SPEED))}
                        className="chip h-10 !px-3 text-lg"
                        aria-label="Speed up Autocue"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-baseline justify-between gap-4">
                      <label htmlFor="autocue-live-font" className="label-mono normal-case tracking-normal">
                        Text size
                      </label>
                      <span className="label-mono tabular-nums">{fontSize} px</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setFontSize((value) => clamp(value - 4, MIN_FONT_SIZE, MAX_FONT_SIZE))}
                        className="chip h-10 !px-3 text-lg"
                        aria-label="Make Autocue text smaller"
                      >
                        −
                      </button>
                      <input
                        id="autocue-live-font"
                        type="range"
                        min={MIN_FONT_SIZE}
                        max={MAX_FONT_SIZE}
                        step="2"
                        value={fontSize}
                        onChange={(event) => setFontSize(Number(event.target.value))}
                        className="min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => setFontSize((value) => clamp(value + 4, MIN_FONT_SIZE, MAX_FONT_SIZE))}
                        className="chip h-10 !px-3 text-lg"
                        aria-label="Make Autocue text larger"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </footer>
            </>
          )}
        </div>
      )}
    </>
  );
}
