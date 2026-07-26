'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnimationPanel from '@/components/AnimationPanel';
import BackgroundPanel from '@/components/BackgroundPanel';
import ExportPanel, { type ExportState } from '@/components/ExportPanel';
import { BrandMark, PauseIcon, PlayIcon, AlertIcon } from '@/components/Icons';
import MusicPanel from '@/components/MusicPanel';
import PreviewStage from '@/components/PreviewStage';
import SharePanel from '@/components/SharePanel';
import SiteFooter from '@/components/SiteFooter';
import SourcePanel, { type AudioOrigin } from '@/components/SourcePanel';
import {
  analyseAudio,
  createDemoAnalysis,
  type AudioAnalysis,
} from '@/lib/analysis';
import {
  LONG_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  decodeAudio,
  formatDuration,
} from '@/lib/audio';
import { canExportMp4, encodeVideo } from '@/lib/encode';
import { mixAudio, musicGainAt } from '@/lib/mix';
import {
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_VOICE_VOLUME,
  type MusicTrack,
  type SelectedMusic,
} from '@/lib/music';
import type { RenderSpec } from '@/lib/render';
import {
  SHARE_TEXT,
  buildFilename,
  canShareFile,
  canShareVideoFiles,
  copyText,
  currentUrl,
  describeShareBlock,
  downloadBlob,
  openShareWindow,
  shareVideoFile,
  siteUrl,
  socialShareUrl,
  type SocialTarget,
} from '@/lib/share';
import {
  DEFAULT_BACKGROUND,
  type AnimationKind,
  type BackgroundChoice,
} from '@/lib/theme';

interface LoadedSource {
  origin: AudioOrigin;
  label: string;
  bytes: number;
  url: string;
  buffer: AudioBuffer;
  analysis: AudioAnalysis;
}

interface LoadedImage {
  element: HTMLImageElement;
  name: string;
  url: string;
}

const FALLBACK_FONTS = { display: 'Georgia, serif', mono: 'monospace' };

const NETWORK_LABEL: Record<SocialTarget, string> = {
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  x: 'X',
  linkedin: 'LinkedIn',
};

/** Shown wherever the browser will not take the file, worded the same way every time. */
const DOWNLOAD_INSTEAD = 'Download your GLASKO video, then upload it to your social media account.';

/**
 * Resolve a CSS custom property to a concrete font stack.
 *
 * `getPropertyValue('--font-display')` is not reliable here: it can hand back an
 * unresolved `var(...)` chain, and assigning that to `ctx.font` fails silently and
 * leaves canvas text at the 10px default. Reading `fontFamily` off a throwaway
 * element forces the browser to do the substitution properly.
 */
function resolveFontStack(variable: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;font-family:var(${variable})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).fontFamily;
    probe.remove();
    return resolved && !resolved.includes('var(') ? resolved : fallback;
  } catch {
    return fallback;
  }
}

export default function Home() {
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [background, setBackground] = useState<BackgroundChoice>(DEFAULT_BACKGROUND);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [animation, setAnimation] = useState<AnimationKind>('wave');
  const [exportState, setExportState] = useState<ExportState>({ phase: 'idle' });
  const [playing, setPlaying] = useState(false);
  const [fonts, setFonts] = useState(FALLBACK_FONTS);
  const [shareSupported, setShareSupported] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [exportSupported, setExportSupported] = useState(true);

  // Background music. The page owns the audition state as well as the selection,
  // so that starting the main preview can stop a track that is being auditioned.
  const [music, setMusic] = useState<SelectedMusic | null>(null);
  const [musicLoadingId, setMusicLoadingId] = useState<string | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const [auditionSrc, setAuditionSrc] = useState<string | null>(null);
  const [voiceVolume, setVoiceVolume] = useState(DEFAULT_VOICE_VOLUME);
  const [musicVolume, setMusicVolume] = useState(DEFAULT_MUSIC_VOLUME);

  const audioRef = useRef<HTMLAudioElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const auditionRef = useRef<HTMLAudioElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const demoAnalysis = useMemo(() => createDemoAnalysis(), []);

  // Resolve the real font family names once the webfonts have loaded, so canvas
  // text uses the same faces as the interface.
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      if (cancelled) return;
      setFonts({
        display: resolveFontStack('--font-display', FALLBACK_FONTS.display),
        mono: resolveFontStack('--font-mono', FALLBACK_FONTS.mono),
      });
    };
    resolve();
    document.fonts?.ready.then(resolve).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setShareSupported(canShareVideoFiles());
    setExportSupported(canExportMp4());
  }, []);

  // Release object URLs when they are replaced or the page unmounts.
  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url);
    };
  }, [source]);

  useEffect(() => {
    return () => {
      if (image) URL.revokeObjectURL(image.url);
    };
  }, [image]);

  // Only uploaded music owns an object URL; built-in tracks are static paths.
  useEffect(() => {
    return () => {
      if (music?.origin === 'upload') URL.revokeObjectURL(music.url);
    };
  }, [music]);

  const spec = useMemo<RenderSpec>(
    () => ({
      background,
      backgroundImage: background.kind === 'image' ? image?.element ?? null : null,
      animation,
      fonts,
    }),
    [animation, background, fonts, image],
  );

  const pausePreview = useCallback(() => {
    audioRef.current?.pause();
    musicRef.current?.pause();
    setPlaying(false);
  }, []);

  const stopAudition = useCallback(() => {
    auditionRef.current?.pause();
    setAuditionId(null);
  }, []);

  const handleAudio = useCallback(
    async (blob: Blob, label: string, origin: AudioOrigin) => {
      pausePreview();
      setNotice(null);
      setExportState({ phase: 'idle' });
      setDecoding(true);
      try {
        const buffer = await decodeAudio(blob);
        if (buffer.duration < 0.35) {
          setNotice('That clip is too short. Record at least half a second.');
          return;
        }
        if (buffer.duration > MAX_DURATION_SECONDS) {
          setNotice(
            `That audio is ${formatDuration(buffer.duration)}. The limit is ${formatDuration(
              MAX_DURATION_SECONDS,
            )} so the export stays reliable on phones.`,
          );
          return;
        }

        const analysis = await analyseAudio(buffer);
        setSource({
          origin,
          label,
          bytes: blob.size,
          url: URL.createObjectURL(blob),
          buffer,
          analysis,
        });

        if (buffer.duration > LONG_DURATION_SECONDS) {
          setNotice(
            `${formatDuration(buffer.duration)} of audio will take a little while to render. Keep this tab open while it works.`,
          );
        }
      } catch (error) {
        setNotice((error as Error)?.message ?? 'That audio could not be read.');
      } finally {
        setDecoding(false);
      }
    },
    [pausePreview],
  );

  const handleClear = useCallback(() => {
    pausePreview();
    setSource(null);
    setExportState({ phase: 'idle' });
    setNotice(null);
  }, [pausePreview]);

  const handleImage = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const element = new Image();
      element.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error('That image could not be loaded.'));
        element.src = url;
      });
      setImage({ element, name: file.name, url });
      setBackground({ kind: 'image', id: 'image', label: 'Your image', src: url });
      setNotice(null);
    } catch (error) {
      URL.revokeObjectURL(url);
      setNotice((error as Error).message);
    }
  }, []);

  const selectTrack = useCallback(async (track: MusicTrack) => {
    setNotice(null);
    setMusicLoadingId(track.id);
    try {
      const response = await fetch(track.src);
      if (!response.ok) throw new Error(`${track.title} could not be loaded.`);
      const blob = await response.blob();
      // Decoded up front so the export never has to wait on the network, and so a
      // broken file is reported here rather than three steps later.
      const buffer = await decodeAudio(blob);
      setMusic({
        id: track.id,
        title: track.title,
        category: track.category,
        artist: track.artist,
        license: track.license,
        duration: buffer.duration,
        url: track.src,
        origin: 'library',
        buffer,
      });
    } catch (error) {
      setNotice((error as Error)?.message ?? 'That track could not be loaded.');
    } finally {
      setMusicLoadingId(null);
    }
  }, []);

  const uploadMusic = useCallback(async (file: File) => {
    setNotice(null);
    setMusicLoadingId('upload');
    let url: string | null = null;
    try {
      const buffer = await decodeAudio(file);
      if (buffer.duration < 0.5) {
        setNotice('That track is too short to use as background music.');
        return;
      }
      url = URL.createObjectURL(file);
      setMusic({
        id: 'upload',
        title: file.name.replace(/\.[^.]+$/, ''),
        category: 'Your upload',
        artist: 'Uploaded by you',
        license: 'You confirmed you have the right to use this track',
        duration: buffer.duration,
        url,
        origin: 'upload',
        buffer,
      });
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      setNotice((error as Error)?.message ?? 'That music file could not be read.');
    } finally {
      setMusicLoadingId(null);
    }
  }, []);

  const removeMusic = useCallback(() => {
    musicRef.current?.pause();
    auditionRef.current?.pause();
    setAuditionId(null);
    // Drop the src too: an uploaded track's object URL is revoked as `music`
    // changes, and leaving a revoked URL on the element is asking for trouble.
    setAuditionSrc(null);
    setMusic(null);
  }, []);

  const toggleAudition = useCallback(
    (id: string, src: string) => {
      if (auditionId === id) {
        stopAudition();
        return;
      }
      // Never two things playing at once — auditioning stops the main preview.
      pausePreview();
      setAuditionSrc(src);
      setAuditionId(id);
    },
    [auditionId, pausePreview, stopAudition],
  );

  // Drive the audition element from the id the panel highlights, so the button
  // state and what you hear can never disagree.
  useEffect(() => {
    const element = auditionRef.current;
    if (!element) return;
    if (!auditionId || !auditionSrc) {
      element.pause();
      return;
    }
    element.volume = 0.85;
    element.currentTime = 0;
    element.play().catch(() => {
      setAuditionId(null);
      setNotice('Playback was blocked. Tap preview again.');
    });
  }, [auditionId, auditionSrc]);

  useEffect(() => {
    const element = audioRef.current;
    if (element) element.volume = Math.min(1, Math.max(0, voiceVolume));
  }, [source, voiceVolume]);

  // Music under the preview. The volume is recomputed from the voice's playback
  // position so the fade matches the curve `mixAudio` bakes into the export.
  useEffect(() => {
    const element = musicRef.current;
    if (!element) return;
    if (!playing || !source || !music) {
      element.pause();
      return;
    }
    const duration = source.analysis.duration;
    const apply = () => {
      const elapsed = audioRef.current?.currentTime ?? 0;
      element.volume = Math.min(1, Math.max(0, musicVolume * musicGainAt(elapsed, duration)));
    };
    apply();
    element.play().catch(() => undefined);
    // 50 ms is fine for a 1.2 s fade, and unlike requestAnimationFrame it keeps
    // running when the tab is hidden — which is where the audio keeps playing.
    const timer = window.setInterval(apply, 50);
    return () => window.clearInterval(timer);
  }, [music, musicVolume, playing, source]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !source) return;
    if (playing) {
      audio.pause();
      musicRef.current?.pause();
      setPlaying(false);
      return;
    }
    stopAudition();
    // Restart from the top once it has run to the end.
    if (audio.ended || audio.currentTime >= source.analysis.duration - 0.05) {
      audio.currentTime = 0;
    }
    // Line the music up with the voice's position, the way the export aligns
    // them, so pausing and resuming does not drift the two apart.
    const musicElement = musicRef.current;
    if (musicElement) {
      const length =
        Number.isFinite(musicElement.duration) && musicElement.duration > 0.05
          ? musicElement.duration
          : music?.duration ?? 0;
      musicElement.currentTime = length > 0.05 ? audio.currentTime % length : 0;
    }
    audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setNotice('Playback was blocked. Tap the play button again.'));
  }, [music, playing, source, stopAudition]);

  const generate = useCallback(async () => {
    if (!source) return;
    pausePreview();
    setShareNotice(null);

    const controller = new AbortController();
    abortRef.current = controller;
    setExportState({
      phase: 'working',
      stage: 'render',
      ratio: 0,
      detail: music ? 'Mixing voice and music' : 'Preparing the encoder',
    });

    try {
      // The mix is flattened to a single buffer here, so all three encode
      // pipelines stay identical whether or not there is background music.
      const audioBuffer = await mixAudio({
        voice: source.buffer,
        music: music?.buffer ?? null,
        voiceVolume,
        musicVolume,
      });
      const result = await encodeVideo({
        audioBuffer,
        analysis: source.analysis,
        spec,
        signal: controller.signal,
        onProgress: ({ stage, ratio, detail }) =>
          setExportState({ phase: 'working', stage, ratio, detail }),
      });
      setExportState({
        phase: 'done',
        result,
        filename: buildFilename(result.mimeType.includes('mp4') ? 'mp4' : 'webm'),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        setExportState({ phase: 'idle' });
        return;
      }
      setExportState({
        phase: 'error',
        message: (error as Error)?.message ?? 'The export failed. Try again.',
      });
    } finally {
      abortRef.current = null;
    }
  }, [music, musicVolume, pausePreview, source, spec, voiceVolume]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  /**
   * The finished MP4 as a real `File`, which is what both `navigator.canShare` and
   * `navigator.share` need — a Blob on its own is not shareable.
   */
  const videoFile = useMemo(() => {
    if (exportState.phase !== 'done') return null;
    return new File([exportState.result.blob], exportState.filename, {
      type: exportState.result.mimeType,
    });
  }, [exportState]);

  // Asked of the actual file rather than a stand-in, so an over-large video is treated
  // as unshareable here too instead of only failing when the button is pressed.
  const fileSharingSupported = videoFile ? canShareFile(videoFile) : shareSupported;

  // A playable URL for the finished file, so the share section can show the real MP4.
  useEffect(() => {
    if (exportState.phase !== 'done') {
      setVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(exportState.result.blob);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [exportState]);

  /** Saves the MP4, reporting a blocked download rather than failing silently. */
  const saveVideo = useCallback((): boolean => {
    if (exportState.phase !== 'done') {
      setShareNotice('There is no video yet. Generate one first.');
      return false;
    }
    const saved = downloadBlob(exportState.result.blob, exportState.filename);
    if (!saved) {
      setShareNotice('The download could not start. Check your browser download settings.');
    }
    return saved;
  }, [exportState]);

  const download = useCallback(() => {
    if (saveVideo()) {
      setShareNotice('Saved to your downloads. Upload it from there in any app.');
    }
  }, [saveVideo]);

  const share = useCallback(async () => {
    if (!videoFile) {
      setShareNotice('There is no video yet. Generate one first.');
      return;
    }
    const blocked = describeShareBlock(videoFile);
    if (blocked === 'too-large') {
      setShareNotice(`This video is too large for your browser to share directly. ${DOWNLOAD_INSTEAD}`);
      return;
    }
    if (blocked === 'unsupported') {
      setShareNotice(DOWNLOAD_INSTEAD);
      setShareSupported(false);
      return;
    }

    const outcome = await shareVideoFile(videoFile, SHARE_TEXT);
    switch (outcome) {
      case 'shared':
        setShareNotice('Handed off to the app you picked.');
        break;
      case 'dismissed':
        setShareNotice('Share cancelled.');
        break;
      case 'too-large':
        setShareNotice(`This video is too large for your browser to share directly. ${DOWNLOAD_INSTEAD}`);
        break;
      case 'unsupported':
        setShareNotice(DOWNLOAD_INSTEAD);
        setShareSupported(false);
        break;
      case 'failed':
        setShareNotice(`Sharing failed. ${DOWNLOAD_INSTEAD}`);
        break;
    }
  }, [videoFile]);

  /**
   * Per-network share.
   *
   * The file goes to the network's own app through the OS share sheet wherever that is
   * possible. Where it is not — desktop, mostly — the MP4 is saved and the network's web
   * share page opens with a link to GLASKO, because no web share endpoint accepts a video
   * upload. The message says so; nothing here pretends the video was posted.
   *
   * `canShareFile` is checked synchronously before any `await`, so the `window.open` on
   * the fallback path still counts as coming from the click.
   */
  const shareTo = useCallback(
    async (target: SocialTarget) => {
      const label = NETWORK_LABEL[target];
      if (!videoFile) {
        setShareNotice('There is no video yet. Generate one first.');
        return;
      }

      if (canShareFile(videoFile)) {
        const outcome = await shareVideoFile(videoFile, SHARE_TEXT);
        if (outcome === 'shared') {
          setShareNotice(`Handed the MP4 to your share sheet — pick ${label} there.`);
          return;
        }
        if (outcome === 'dismissed') {
          setShareNotice('Share cancelled.');
          return;
        }
        // Anything else falls through to the link route below.
      }

      const saved = saveVideo();
      const opened = openShareWindow(socialShareUrl(target, siteUrl(), SHARE_TEXT));
      if (!opened) {
        setShareNotice(
          `Your browser blocked the ${label} window. Allow pop-ups for this site, or open ${label} yourself and attach the downloaded MP4.`,
        );
        return;
      }
      setShareNotice(
        saved
          ? `${label} opened with a link to GLASKO. It cannot receive a video from a web page, so attach the MP4 that just downloaded.`
          : `${label} opened with a link to GLASKO. Use Download MP4, then attach the file there yourself.`,
      );
    },
    [saveVideo, videoFile],
  );

  const copyLink = useCallback(async () => {
    const copied = await copyText(currentUrl());
    setShareNotice(
      copied ? 'Link copied.' : 'The clipboard is blocked in this browser. Copy the address bar instead.',
    );
  }, []);

  // Preview clock: real playback position, or a looping demo before any audio.
  const getTime = useCallback(() => {
    if (source) return audioRef.current?.currentTime ?? 0;
    return (performance.now() / 1000) % demoAnalysis.duration;
  }, [demoAnalysis.duration, source]);

  const previewAnalysis = source?.analysis ?? demoAnalysis;
  const animating = source ? playing : true;
  const busy = exportState.phase === 'working';

  return (
    <main className="mx-auto w-full max-w-6xl px-5 pb-20 pt-9 sm:px-8 lg:px-12 lg:pt-14">
      <header className="rise">
        <div className="flex items-center gap-2.5 text-ember">
          <BrandMark className="h-4 w-4" />
          <span className="font-mono text-xs track-wide uppercase">Glasko</span>
        </div>
        <h1 className="mt-6 max-w-xl font-display text-[2.6rem] leading-[1.04] tracking-[-0.015em] sm:text-6xl">
          Turn your voice into
          <br />
          social video.
        </h1>
        <p className="mt-5 max-w-md text-[0.95rem] leading-relaxed text-ash">
          Record or upload a voice message, pick a backdrop, a waveform and a music bed, and export
          a vertical MP4 built for TikTok, Reels and Shorts. Everything runs in this browser tab —
          the audio never leaves your device.
        </p>
      </header>

      {!exportSupported && (
        <div
          className="mt-8 flex items-start gap-3 border border-clay/60 bg-clay/[0.12] px-4 py-3.5 text-sm"
          role="alert"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-clay" />
          <p className="text-bone">
            This browser cannot encode video. You can still record and preview, but for the MP4
            export use a recent Chrome, Edge or Safari.
          </p>
        </div>
      )}

      {notice && (
        <div
          className="mt-8 flex items-start gap-3 border border-bone/14 bg-bone/[0.04] px-4 py-3.5 text-sm"
          role="status"
          aria-live="polite"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-ember" />
          <p className="text-bone">{notice}</p>
        </div>
      )}

      <div className="mt-10 grid gap-x-16 lg:grid-cols-[minmax(0,1fr)_356px] lg:items-start">
        <div className="order-1 lg:col-start-1 lg:row-start-1">
          <SourcePanel
            source={
              source
                ? {
                    label: source.label,
                    duration: source.analysis.duration,
                    origin: source.origin,
                    bytes: source.bytes,
                  }
                : null
            }
            decoding={decoding}
            onAudio={handleAudio}
            onClear={handleClear}
            onError={setNotice}
          />
          <BackgroundPanel
            value={background}
            imageName={image?.name ?? null}
            onChange={setBackground}
            onImage={handleImage}
            onError={setNotice}
          />
          <AnimationPanel value={animation} onChange={setAnimation} />
          <MusicPanel
            selected={music}
            loadingId={musicLoadingId}
            auditionId={auditionId}
            voiceDuration={source?.analysis.duration ?? 0}
            voiceVolume={voiceVolume}
            musicVolume={musicVolume}
            onSelect={selectTrack}
            onUpload={uploadMusic}
            onRemove={removeMusic}
            onAudition={toggleAudition}
            onVoiceVolume={setVoiceVolume}
            onMusicVolume={setMusicVolume}
            onError={setNotice}
          />
        </div>

        <aside className="order-2 mt-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:sticky lg:top-14 lg:self-start">
          <div className="mb-4 flex items-baseline justify-between">
            <span className="label-mono">Preview</span>
            {source && (
              <span className="label-mono tabular-nums">
                {formatDuration(source.analysis.duration)}
              </span>
            )}
          </div>

          <PreviewStage
            analysis={previewAnalysis}
            spec={spec}
            getTime={getTime}
            animating={animating}
          >
            <button
              type="button"
              onClick={togglePlay}
              disabled={!source || busy}
              className="absolute bottom-3.5 left-3.5 grid h-11 w-11 place-items-center rounded-full border border-bone/25 bg-ink/70 text-bone backdrop-blur-md transition-colors hover:border-bone/60 disabled:opacity-0"
              aria-label={playing ? 'Pause preview' : 'Play preview'}
            >
              {playing ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            </button>

            {!source && (
              <span className="pointer-events-none absolute inset-x-0 bottom-4 text-center font-mono text-[0.625rem] uppercase tracking-[0.16em] text-bone/45">
                Sample motion
              </span>
            )}
          </PreviewStage>
        </aside>

        <div className="order-3 lg:col-start-1 lg:row-start-2">
          <ExportPanel
            ready={Boolean(source) && !decoding}
            duration={source?.analysis.duration ?? 0}
            state={exportState}
            onGenerate={generate}
            onCancel={cancel}
          />

          {exportState.phase === 'done' && (
            <SharePanel
              videoUrl={videoUrl}
              sizeBytes={exportState.result.blob.size}
              filename={exportState.filename}
              fileSharingSupported={fileSharingSupported}
              notice={shareNotice}
              onShare={share}
              onSocial={shareTo}
              onCopyLink={copyLink}
              onDownload={download}
            />
          )}
        </div>
      </div>

      {source && (
        <audio
          ref={audioRef}
          src={source.url}
          preload="auto"
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          className="hidden"
        />
      )}

      {/* Music under the preview. Looped in the element for the same reason it is
          looped in the mix: a short track should cover the whole voice. */}
      {music && (
        <audio ref={musicRef} src={music.url} loop preload="auto" className="hidden" />
      )}

      {/* Audition player for the picker. Always mounted so the first tap plays
          immediately instead of waiting for the element to be created. */}
      <audio
        ref={auditionRef}
        src={auditionSrc ?? undefined}
        preload="none"
        onEnded={() => setAuditionId(null)}
        className="hidden"
      />

      <SiteFooter />
    </main>
  );
}
