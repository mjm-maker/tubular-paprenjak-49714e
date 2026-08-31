'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, StopIcon } from './Icons';

const AUTOCUE_STORAGE_KEY = 'glasko:autocue:v1';
const DEFAULT_SPEED = 28;
const DEFAULT_FONT_SIZE = 42;

type FacingMode = 'user' | 'environment';

interface SavedAutocue {
  script?: string;
  speed?: number;
  fontSize?: number;
}

interface LiveCameraTestProps {
  onError: (message: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cameraError(error: unknown): string {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow Camera and Microphone for GLASKO, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No suitable camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is busy in another app. Close it there and try again.';
  }
  return 'GLASKO could not open the camera. Check the browser permissions and try again.';
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function LiveCameraTest({ onError }: LiveCameraTestProps) {
  const [open, setOpen] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>('user');
  const [script, setScript] = useState('');
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [scrolling, setScrolling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cameraSupported, setCameraSupported] = useState(true);
  const [storageReady, setStorageReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownRunRef = useRef(0);

  const words = useMemo(() => (script.trim() ? script.trim().split(/\s+/u).length : 0), [script]);

  useEffect(() => {
    setCameraSupported(Boolean(navigator.mediaDevices?.getUserMedia));
    try {
      const raw = window.localStorage.getItem(AUTOCUE_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as SavedAutocue;
        if (typeof saved.script === 'string') setScript(saved.script);
        if (typeof saved.speed === 'number') setSpeed(clamp(saved.speed, 12, 60));
        if (typeof saved.fontSize === 'number') setFontSize(clamp(saved.fontSize, 28, 64));
      }
    } catch {
      // Private browsing may block storage. The camera test still works without it.
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(
        AUTOCUE_STORAGE_KEY,
        JSON.stringify({ script, speed, fontSize }),
      );
    } catch {
      // Saving the script is optional.
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
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        setScrolling(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [countdown, scrolling, speed]);

  const resetText = useCallback(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, []);

  const attachStream = useCallback(async (stream: MediaStream) => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    await video.play();
  }, []);

  useEffect(() => {
    const stream = streamRef.current;
    if (!cameraActive || !stream) return;
    void attachStream(stream).catch(() => {
      // A muted inline video normally autoplays. If an engine still blocks it,
      // the camera remains active and the next user interaction retries playback.
    });
  }, [attachStream, cameraActive, facingMode]);

  const startCamera = useCallback(
    async (nextFacingMode: FacingMode = facingMode) => {
      if (!navigator.mediaDevices?.getUserMedia || starting) return;
      setStarting(true);
      setScrolling(false);
      countdownRunRef.current += 1;
      setCountdown(null);
      const previousStream = streamRef.current;
      streamRef.current = null;
      stopStream(previousStream);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: nextFacingMode },
            width: { ideal: 1080 },
            height: { ideal: 1920 },
            aspectRatio: { ideal: 9 / 16 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
        setFacingMode(nextFacingMode);
        setCameraActive(true);
        await attachStream(stream);
      } catch (error) {
        setCameraActive(false);
        onError(cameraError(error));
      } finally {
        setStarting(false);
      }
    },
    [attachStream, facingMode, onError, starting],
  );

  const close = useCallback(() => {
    countdownRunRef.current += 1;
    setCountdown(null);
    setScrolling(false);
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setOpen(false);
  }, []);

  useEffect(() => {
    return () => stopStream(streamRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close, open]);

  const startText = useCallback(async () => {
    if (!script.trim()) {
      onError('Paste your live script before starting the autocue.');
      return;
    }
    const run = countdownRunRef.current + 1;
    countdownRunRef.current = run;
    resetText();
    setScrolling(false);
    for (let value = 3; value >= 1; value -= 1) {
      if (countdownRunRef.current !== run) return;
      setCountdown(value);
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    if (countdownRunRef.current !== run) return;
    setCountdown(null);
    setScrolling(true);
  }, [onError, resetText, script]);

  const flipCamera = useCallback(() => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    void startCamera(next);
  }, [facingMode, startCamera]);

  return (
    <>
      <section className="mt-10 border border-ember/25 bg-ember/[0.045] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1877f2] font-sans text-lg font-bold text-white">
              f
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-2xl">Facebook LIVE camera</h2>
                <span className="rounded-full border border-ember/35 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-[0.14em] text-ember">
                  Test mode
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ash">
                Test the full-screen 9:16 camera and private autocue before the Facebook streaming connection is added.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!cameraSupported}
            className="chip shrink-0 justify-center py-3 sm:ml-auto"
          >
            Test live camera
          </button>
        </div>
        {!cameraSupported && (
          <p className="mt-3 text-sm text-clay">This browser cannot open a live camera.</p>
        )}
      </section>

      {open && (
        <div
          className="fixed inset-0 z-[110] flex min-h-[100dvh] flex-col bg-[#020304] text-bone"
          role="dialog"
          aria-modal="true"
          aria-label="Facebook LIVE camera test"
        >
          <header className="relative z-30 flex items-center justify-between gap-3 border-b border-bone/10 bg-[#050607]/95 px-3 py-3 backdrop-blur sm:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-clay" />
                <p className="label-mono truncate text-ember">Facebook LIVE camera test</p>
              </div>
              <p className="mt-1 text-xs text-ash">Private preview · Facebook is not receiving video yet</p>
            </div>
            <button type="button" onClick={close} className="chip shrink-0">
              Close test
            </button>
          </header>

          {!cameraActive ? (
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
              <div className="rounded-[3px] border border-bone/12 bg-bone/[0.025] px-4 py-4">
                <p className="text-sm text-bone">Before the camera opens</p>
                <p className="mt-2 text-sm leading-relaxed text-ash">
                  Allow both Camera and Microphone. Your video stays on this device during this test.
                </p>
              </div>

              <label htmlFor="live-test-script" className="text-sm text-bone">
                Live autocue script
              </label>
              <textarea
                id="live-test-script"
                value={script}
                onChange={(event) => setScript(event.target.value)}
                placeholder="Paste what you want to say during the live video…"
                className="min-h-[32dvh] w-full resize-none rounded-[3px] border border-bone/16 bg-bone/[0.035] px-4 py-4 text-lg leading-relaxed text-bone placeholder:text-ash/70 focus:border-ember"
              />
              <p className="label-mono normal-case tracking-normal">
                {words ? `${words} words · shared with the ordinary GLASKO Autocue` : 'The text is visible only to you'}
              </p>

              <button
                type="button"
                onClick={() => void startCamera()}
                disabled={starting}
                className="btn-primary mt-auto"
              >
                {starting ? 'Opening camera' : 'Open camera test'}
              </button>
            </div>
          ) : (
            <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
              <div
                className="relative mx-auto h-auto max-h-full overflow-hidden bg-black"
                style={{ width: 'min(100vw, calc(56.25dvh - 2.6rem))', aspectRatio: '9 / 16' }}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : undefined }}
                />

                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-4">
                  <img src="/glasko-logo.png" alt="" className="h-auto w-28" />
                  <span className="rounded-[3px] bg-clay px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.14em] text-white">
                    Live test
                  </span>
                </div>

                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-transparent via-black/10 to-black/65" />

                <div
                  ref={scrollerRef}
                  className="absolute inset-x-3 bottom-24 top-[20%] z-20 overflow-y-auto overscroll-contain rounded-[3px] bg-black/24 px-3 backdrop-blur-[2px] sm:inset-x-6"
                >
                  <div className="pb-[52vh] pt-[22vh]">
                    <p
                      className="whitespace-pre-wrap text-center font-sans font-semibold leading-[1.45] text-white [text-shadow:0_2px_12px_rgba(0,0,0,0.9)]"
                      style={{ fontSize: `${fontSize}px` }}
                    >
                      {script.trim() || 'Your private autocue will appear here.'}
                    </p>
                  </div>
                </div>

                <div className="pointer-events-none absolute inset-x-5 top-[43%] z-20 h-px bg-ember/55" />

                {countdown !== null && (
                  <div className="absolute inset-0 z-30 grid place-items-center bg-black/72">
                    <span className="font-display text-[8rem] leading-none text-ember">{countdown}</span>
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 z-30 border-t border-white/12 bg-black/78 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={resetText} className="chip shrink-0 !border-white/18 !bg-black/25">
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={scrolling ? () => setScrolling(false) : () => void startText()}
                      disabled={countdown !== null}
                      className="chip min-w-0 flex-1 justify-center !border-white/18 !bg-black/25"
                    >
                      {scrolling ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                      {scrolling ? 'Pause text' : 'Start text'}
                    </button>
                    <button
                      type="button"
                      onClick={flipCamera}
                      disabled={starting}
                      className="chip shrink-0 !border-white/18 !bg-black/25"
                    >
                      Flip
                    </button>
                    <button type="button" onClick={close} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-clay text-white">
                      <StopIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between gap-3">
                    <label htmlFor="live-test-speed" className="font-mono text-[0.6rem] uppercase tracking-[0.13em] text-white/65">
                      Text speed
                    </label>
                    <span className="font-mono text-[0.6rem] text-white/65">{speed} px/s</span>
                  </div>
                  <input
                    id="live-test-speed"
                    type="range"
                    min="12"
                    max="60"
                    step="1"
                    value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                    className="mt-0.5"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
