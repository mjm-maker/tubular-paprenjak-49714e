'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccountNav from '@/components/AccountNav';
import AnimationPanel from '@/components/AnimationPanel';
import BackgroundPanel from '@/components/BackgroundPanel';
import ExportPanel, { type ExportState } from '@/components/ExportPanel';
import FormatPanel from '@/components/FormatPanel';
import HeadlinePanel from '@/components/HeadlinePanel';
import { PauseIcon, PlayIcon, AlertIcon } from '@/components/Icons';
import MusicPanel from '@/components/MusicPanel';
import PicturePanel from '@/components/PicturePanel';
import PreviewStage from '@/components/PreviewStage';
import SharePanel from '@/components/SharePanel';
import SiteFooter from '@/components/SiteFooter';
import SourcePanel, { type AudioOrigin } from '@/components/SourcePanel';
import SubtitlePanel, { type SubtitleStatus } from '@/components/SubtitlePanel';
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
  unlockAudioContext,
} from '@/lib/audio';
import {
  audioProved,
  canExportMp4,
  encodeVideo,
  ExportError,
  PIPELINES,
  type Pipeline,
} from '@/lib/encode';
import { DEFAULT_HEADLINE, headlineText, type HeadlineSettings } from '@/lib/headline';
import { DEFAULT_FORMAT, formatById, type FormatId } from '@/lib/layout';
import { type BrandLogo, loadBrandLogo } from '@/lib/logo';
import {
  buildDuckEnvelope,
  duckGainAt,
  effectiveMusicLevel,
  mixAudio,
  musicGainAt,
} from '@/lib/mix';
import {
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_VOICE_VOLUME,
  type MusicTrack,
  type SelectedMusic,
} from '@/lib/music';
import { DEFAULT_PICTURE, type PictureSettings } from '@/lib/picture';
import type { RenderSpec } from '@/lib/render';
import {
  SHARE_TEXT,
  buildFilename,
  canShareFile,
  canShareVideoFiles,
  copyText,
  describeShareBlock,
  downloadBlob,
  shareVideoFile,
  siteUrl,
} from '@/lib/share';
import {
  DEFAULT_SUBTITLE_SETTINGS,
  languagesFor,
  modeNeedsLanguage,
  toSrt,
  toVtt,
  type SubtitleCue,
  type SubtitleLanguage,
  type SubtitleSettings,
} from '@/lib/subtitles';
import {
  DEFAULT_BACKGROUND,
  type AnimationKind,
  type BackgroundChoice,
} from '@/lib/theme';
import {
  SubtitleError,
  downloadText,
  transcribeVoice,
  translateCues,
} from '@/lib/transcribe';
import { DEFAULT_WATERMARK, watermarkFor, type WatermarkSettings } from '@/lib/watermark';

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

const FALLBACK_FONTS = {
  display: 'Georgia, serif',
  mono: 'monospace',
  sans: 'system-ui, sans-serif',
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

/** Turn a thrown subtitle error into the state the panel shows. */
function subtitleErrorState(error: unknown): SubtitleStatus {
  if (error instanceof SubtitleError) {
    return { phase: 'error', message: error.message, setup: error.code === 'not-configured' };
  }
  return {
    phase: 'error',
    message: (error as Error)?.message ?? 'Subtitles could not be generated. Please try again.',
  };
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
  const [logo, setLogo] = useState<BrandLogo | null>(null);
  const [shareSupported, setShareSupported] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [exportSupported, setExportSupported] = useState(true);
  // Dev-only, resolved from the URL in an effect below.
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [forcedPipeline, setForcedPipeline] = useState<Pipeline | null>(null);

  // Output shape and branding.
  const [formatId, setFormatId] = useState<FormatId>(DEFAULT_FORMAT.id);
  const [watermark, setWatermark] = useState<WatermarkSettings>(DEFAULT_WATERMARK);

  // The picture window and its own artwork. The settings can name the backdrop image
  // instead, which is why the upload is kept even while that option is selected —
  // switching back should not mean uploading the same photo twice.
  const [picture, setPicture] = useState<PictureSettings>(DEFAULT_PICTURE);
  const [pictureImage, setPictureImage] = useState<LoadedImage | null>(null);

  // The topic line along the top of the frame.
  const [headline, setHeadline] = useState<HeadlineSettings>(DEFAULT_HEADLINE);

  // Subtitles. The cues are language-complete; the mode only decides what is drawn.
  const [subtitles, setSubtitles] = useState<SubtitleSettings>(DEFAULT_SUBTITLE_SETTINGS);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [detected, setDetected] = useState<SubtitleLanguage | null>(null);
  const [subtitleStatus, setSubtitleStatus] = useState<SubtitleStatus>({ phase: 'idle' });

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
  const subtitleAbortRef = useRef<AbortController | null>(null);
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
        // Subtitles and the watermark: the one stack with Cyrillic in it.
        sans: resolveFontStack('--font-caption', FALLBACK_FONTS.sans),
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

  // The dev-only export readout, and the switch that forces one pipeline.
  //
  // Read from the URL in an effect rather than at render, because `window` does not exist
  // during the server render and a value that differs between the two is a hydration
  // mismatch. `?diagnostics=1` is what makes the readout reachable on a Deploy Preview,
  // where the build is a production build; `?pipeline=mediarecorder` forces one route so
  // each of the three can be tested on its own rather than only whichever one this
  // browser reaches for first. Neither appears in the normal product UI.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setShowDiagnostics(process.env.NODE_ENV !== 'production' || params.has('diagnostics'));
    const forced = params.get('pipeline');
    if (forced && (PIPELINES as readonly string[]).includes(forced)) {
      setForcedPipeline(forced as Pipeline);
    }
  }, []);

  // The logo the frame is branded with. Drawing is synchronous and loading is not,
  // so it arrives in state and reaches the renderer through `spec` — which is the
  // same object the exporter uses, so the preview and the MP4 get the same mark.
  // Until it lands, `drawFrame` paints the wordmark it always painted.
  useEffect(() => {
    let cancelled = false;
    loadBrandLogo().then((loaded) => {
      if (!cancelled && loaded) setLogo(loaded);
    });
    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    return () => {
      if (pictureImage) URL.revokeObjectURL(pictureImage.url);
    };
  }, [pictureImage]);

  // Only uploaded music owns an object URL; built-in tracks are static paths.
  useEffect(() => {
    return () => {
      if (music?.origin === 'upload') URL.revokeObjectURL(music.url);
    };
  }, [music]);

  const format = useMemo(() => formatById(formatId), [formatId]);

  /**
   * Sidechain envelope for the music bed, measured from the voice.
   *
   * Built once here and handed to both the live preview and `mixAudio`, so what you
   * hear in the tab and what lands in the file are the same curve rather than two
   * implementations of it.
   */
  const duck = useMemo(
    () => (source && music ? buildDuckEnvelope(source.buffer) : null),
    [music, source],
  );

  /**
   * The artwork the picture window actually draws.
   *
   * The backdrop option only resolves while a backdrop *image* is loaded — a colour or
   * a gradient has no artwork to inset — and an empty window is nothing rather than a
   * blank plate, which is why this can be null with the switch still on.
   */
  const pictureArtwork = useMemo(() => {
    if (!picture.enabled) return null;
    if (picture.source === 'background') {
      return background.kind === 'image' ? image?.element ?? null : null;
    }
    return pictureImage?.element ?? null;
  }, [background.kind, image, picture.enabled, picture.source, pictureImage]);

  const spec = useMemo<RenderSpec>(
    () => ({
      format,
      background,
      backgroundImage: background.kind === 'image' ? image?.element ?? null : null,
      animation,
      fonts,
      logo,
      picture: pictureArtwork ? { settings: picture, image: pictureArtwork } : null,
      // An empty topic draws nothing, so it is resolved to null here rather than
      // leaving the renderer to measure a blank string.
      headline: headlineText(headline) ? headline : null,
      subtitles:
        subtitles.mode !== 'none' && cues.length > 0 ? { cues, settings: subtitles } : null,
      // Mandatory in the free version: `watermarkFor` decides `enabled`, and the state
      // above only carries the corner, so nothing here can clear the mark. A future
      // GLASKO PRO account would pass `true` as the second argument.
      watermark: watermarkFor(watermark),
    }),
    [
      animation,
      background,
      cues,
      fonts,
      format,
      headline,
      image,
      logo,
      picture,
      pictureArtwork,
      subtitles,
      watermark,
    ],
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

  const clearSubtitles = useCallback(() => {
    subtitleAbortRef.current?.abort();
    setCues([]);
    setDetected(null);
    setSubtitleStatus({ phase: 'idle' });
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
        // A transcript belongs to one recording. A new one invalidates it.
        clearSubtitles();

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
    [clearSubtitles, pausePreview],
  );

  const handleClear = useCallback(() => {
    pausePreview();
    setSource(null);
    setExportState({ phase: 'idle' });
    setNotice(null);
    clearSubtitles();
  }, [clearSubtitles, pausePreview]);

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

  /**
   * The picture window's own artwork.
   *
   * Decoded here rather than in the renderer for the same reason the backdrop is: the
   * draw call is synchronous, so the frame needs an element that is already loaded.
   * Uploading also selects the upload as the source, since asking for an image and
   * then not seeing it would otherwise be the result of leaving the backdrop selected.
   */
  const handlePictureImage = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const element = new Image();
      element.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error('That image could not be loaded.'));
        element.src = url;
      });
      setPictureImage({ element, name: file.name, url });
      setPicture((previous) => ({ ...previous, enabled: true, source: 'upload' }));
      setNotice(null);
    } catch (error) {
      URL.revokeObjectURL(url);
      setNotice((error as Error).message);
    }
  }, []);

  /** Drops the window's upload. The window itself stays on, and can fall back to the
   *  backdrop image if that is what is selected. */
  const removePictureImage = useCallback(() => {
    setPictureImage(null);
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
  // position through the same three functions the export bakes in: the headroom cap,
  // the fade envelope and the ducking curve.
  useEffect(() => {
    const element = musicRef.current;
    if (!element) return;
    if (!playing || !source || !music) {
      element.pause();
      return;
    }
    const duration = source.analysis.duration;
    const level = effectiveMusicLevel(musicVolume, voiceVolume);
    const apply = () => {
      const elapsed = audioRef.current?.currentTime ?? 0;
      const gain = level * musicGainAt(elapsed, duration) * duckGainAt(duck, elapsed);
      element.volume = Math.min(1, Math.max(0, gain));
    };
    apply();
    element.play().catch(() => undefined);
    // 50 ms is fine for a 1.2 s fade, and unlike requestAnimationFrame it keeps
    // running when the tab is hidden — which is where the audio keeps playing.
    const timer = window.setInterval(apply, 50);
    return () => window.clearInterval(timer);
  }, [duck, music, musicVolume, playing, source, voiceVolume]);

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

  /* ---------------------------------------------------------------- subtitles */

  /**
   * Transcribe, then translate if the chosen mode needs a second language.
   *
   * Shared by the Subtitles panel and the export, so a video generated with a mode
   * selected but nothing transcribed yet still comes out with subtitles on it.
   */
  const buildSubtitles = useCallback(
    async (
      voice: AudioBuffer,
      analysis: AudioAnalysis,
      mode: SubtitleSettings['mode'],
      signal: AbortSignal,
      report: (detail: string, ratio: number) => void,
    ): Promise<SubtitleCue[]> => {
      const result = await transcribeVoice({
        voice,
        analysis,
        signal,
        onProgress: ({ detail, ratio, stage }) =>
          report(detail, stage === 'prepare' ? ratio * 0.08 : 0.08 + ratio * 0.62),
      });
      setDetected(result.language);

      const missing = languagesFor(mode).find((language) => language !== result.language);
      if (!missing) {
        setCues(result.cues);
        return result.cues;
      }

      const translated = await translateCues({
        cues: result.cues,
        from: result.language,
        to: missing,
        signal,
        onProgress: ({ detail, ratio }) => report(detail, 0.7 + ratio * 0.3),
      });
      setCues(translated);
      return translated;
    },
    [],
  );

  const generateSubtitles = useCallback(async () => {
    if (!source) return;
    subtitleAbortRef.current?.abort();
    const controller = new AbortController();
    subtitleAbortRef.current = controller;
    setSubtitleStatus({ phase: 'working', detail: 'Preparing audio', ratio: 0.02 });
    try {
      await buildSubtitles(
        source.buffer,
        source.analysis,
        subtitles.mode,
        controller.signal,
        (detail, ratio) => setSubtitleStatus({ phase: 'working', detail, ratio }),
      );
      setSubtitleStatus({ phase: 'ready' });
    } catch (error) {
      if (controller.signal.aborted) {
        setSubtitleStatus({ phase: 'idle' });
        return;
      }
      // A part that failed does not throw away the parts that finished. Keeping them
      // means Generate again picks up from a transcript rather than from nothing, and
      // the lines that were already heard stay on the preview while the error shows.
      if (error instanceof SubtitleError && error.partialCues?.length) {
        setCues(error.partialCues);
        if (error.partialLanguage) setDetected(error.partialLanguage);
      }
      setSubtitleStatus(subtitleErrorState(error));
    } finally {
      if (subtitleAbortRef.current === controller) subtitleAbortRef.current = null;
    }
  }, [buildSubtitles, source, subtitles.mode]);

  /** Fill in a second language for cues that already exist. */
  const fillLanguage = useCallback(
    async (target: SubtitleLanguage, current: SubtitleCue[]) => {
      if (!detected || target === detected || current.length === 0) return;
      subtitleAbortRef.current?.abort();
      const controller = new AbortController();
      subtitleAbortRef.current = controller;
      setSubtitleStatus({ phase: 'working', detail: 'Translating subtitles', ratio: 0.05 });
      try {
        const translated = await translateCues({
          cues: current,
          from: detected,
          to: target,
          signal: controller.signal,
          onProgress: ({ detail, ratio }) =>
            setSubtitleStatus({ phase: 'working', detail, ratio: Math.max(0.05, ratio) }),
        });
        setCues(translated);
        setSubtitleStatus({ phase: 'ready' });
      } catch (error) {
        if (controller.signal.aborted) {
          setSubtitleStatus({ phase: 'idle' });
          return;
        }
        setSubtitleStatus(subtitleErrorState(error));
      } finally {
        if (subtitleAbortRef.current === controller) subtitleAbortRef.current = null;
      }
    },
    [detected],
  );

  /**
   * Settings changes are free except one: switching to a mode that needs a language
   * the cues do not carry yet. That one triggers a translation rather than silently
   * drawing blanks.
   */
  const applySubtitleSettings = useCallback(
    (next: SubtitleSettings) => {
      setSubtitles(next);
      if (cues.length === 0 || subtitleStatus.phase === 'working') return;
      const missing = languagesFor(next.mode).find((language) =>
        modeNeedsLanguage(cues, language),
      );
      if (missing) void fillLanguage(missing, cues);
    },
    [cues, fillLanguage, subtitleStatus.phase],
  );

  const cancelSubtitles = useCallback(() => subtitleAbortRef.current?.abort(), []);

  const editCue = useCallback((id: string, language: SubtitleLanguage, text: string) => {
    setCues((previous) =>
      previous.map((cue) => (cue.id === id ? ({ ...cue, [language]: text } as SubtitleCue) : cue)),
    );
  }, []);

  const downloadSubtitles = useCallback(
    (kind: 'srt' | 'vtt') => {
      if (cues.length === 0) return;
      // Subtitles switched off still have a transcript worth downloading, so fall
      // back to whichever language was actually spoken rather than to an empty file.
      const mode = subtitles.mode === 'none' ? detected ?? 'bg' : subtitles.mode;
      const text = kind === 'srt' ? toSrt(cues, mode) : toVtt(cues, mode);
      downloadText(text, buildFilename(kind), kind === 'srt' ? 'text/plain' : 'text/vtt');
    },
    [cues, detected, subtitles.mode],
  );

  /* ------------------------------------------------------------------- export */

  const generate = useCallback(async () => {
    if (!source) return;

    // First thing, before a single await: iOS Safari only lets an audio graph start from
    // inside a user gesture, and it counts the gesture as spent as soon as this handler
    // yields. The real-time capture pipeline needs a running context long after the
    // transcript and the mix have finished, so it is unlocked here, on the tap itself.
    // Everything downstream — playback, and decoding the finished file to check it — uses
    // this one context rather than opening more, which iOS also limits.
    const audioContext = unlockAudioContext();

    pausePreview();
    setShareNotice(null);

    // A transcript still running in the Subtitles panel would race this one on `setCues`
    // and could finish last with the wrong language set, so it yields to the export.
    subtitleAbortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    // Subtitles are generated here when the mode asks for them and there is no
    // transcript yet, so the file always matches what the panel says it will be.
    const needsTranscript = subtitles.mode !== 'none' && cues.length === 0;
    const missingLanguage =
      subtitles.mode !== 'none' && cues.length > 0
        ? languagesFor(subtitles.mode).find((language) => modeNeedsLanguage(cues, language))
        : undefined;

    setExportState({
      phase: 'working',
      stage: 'render',
      ratio: 0,
      label: needsTranscript ? 'Generating subtitles' : 'Preparing audio',
      detail: needsTranscript ? 'Listening to your voice' : music ? 'Mixing voice and music' : 'Reading the recording',
    });

    try {
      let exportCues = cues;

      if (needsTranscript) {
        exportCues = await buildSubtitles(
          source.buffer,
          source.analysis,
          subtitles.mode,
          controller.signal,
          (detail, ratio) => {
            const label = detail.startsWith('Translating')
              ? 'Translating subtitles'
              : 'Generating subtitles';
            setSubtitleStatus({ phase: 'working', detail, ratio });
            // Transcription is the first fifth of the whole export.
            setExportState({ phase: 'working', stage: 'render', ratio: ratio * 0.2, detail, label });
          },
        );
        setSubtitleStatus({ phase: 'ready' });
      } else if (missingLanguage) {
        setExportState({
          phase: 'working',
          stage: 'render',
          ratio: 0.05,
          label: 'Translating subtitles',
          detail: 'Translating subtitles',
        });
        exportCues = await translateCues({
          cues,
          // The language the cues already carry is, by definition, the one that is not
          // missing. Derived rather than read from `detected`, which is null whenever the
          // cues outlived the run that produced them — and a null there used to skip this
          // branch entirely and export a bilingual video with one language blank.
          from: missingLanguage === 'bg' ? 'en' : 'bg',
          to: missingLanguage,
          signal: controller.signal,
          onProgress: ({ detail, ratio }) => {
            setSubtitleStatus({ phase: 'working', detail, ratio });
            setExportState({
              phase: 'working',
              stage: 'render',
              ratio: ratio * 0.2,
              detail,
              label: 'Translating subtitles',
            });
          },
        });
        setCues(exportCues);
        setSubtitleStatus({ phase: 'ready' });
      }

      const base = needsTranscript || missingLanguage ? 0.2 : 0;

      setExportState({
        phase: 'working',
        stage: 'render',
        ratio: base,
        label: 'Preparing audio',
        detail: music ? 'Mixing voice and music' : 'Reading the recording',
      });

      // The mix is flattened to a single buffer here, so all three encode
      // pipelines stay identical whether or not there is background music.
      const audioBuffer = await mixAudio({
        voice: source.buffer,
        music: music?.buffer ?? null,
        voiceVolume,
        musicVolume,
        duck,
      });

      const result = await encodeVideo({
        audioBuffer,
        analysis: source.analysis,
        // Built here rather than read from `spec`, because the cues may have been
        // produced a few lines ago and React state has not caught up yet.
        spec: {
          ...spec,
          subtitles:
            subtitles.mode !== 'none' && exportCues.length > 0
              ? { cues: exportCues, settings: subtitles }
              : null,
        },
        audioContext,
        signal: controller.signal,
        // The voice before the mix, for the diagnostics readout only — comparing its
        // level with the mixed buffer's is what separates a silent recording from a
        // mix that lost it, which look identical in the finished file.
        voiceBuffer: source.buffer,
        // Null unless the dev selector forced one route.
        only: forcedPipeline,
        onProgress: ({ stage, ratio, detail }) =>
          setExportState({
            phase: 'working',
            stage,
            ratio: base + ratio * (1 - base),
            detail,
          }),
      });

      setExportState({
        phase: 'done',
        result,
        filename: buildFilename(result.mimeType.includes('mp4') ? 'mp4' : 'webm'),
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || controller.signal.aborted) {
        setExportState({ phase: 'idle' });
        return;
      }
      setExportState({
        phase: 'error',
        message: (error as Error)?.message ?? 'The export failed. Try again.',
        // An export that produced no file is the case where the measurements matter
        // most, so they travel with the error rather than only with a result.
        diagnostics: error instanceof ExportError ? error.diagnostics : null,
      });
    } finally {
      abortRef.current = null;
    }
  }, [
    buildSubtitles,
    cues,
    duck,
    forcedPipeline,
    music,
    musicVolume,
    pausePreview,
    source,
    spec,
    subtitles,
    voiceVolume,
  ]);

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

  /**
   * Whether the finished file was proved to carry sound. The encoder already refuses to
   * return one that was not, so in practice this is always true — it is read here anyway
   * because a silent upload is the one failure that looks like a success, and the file
   * should not reach a share sheet on the strength of an assumption.
   *
   * `audioProved` rather than the proof's own `audible` flag, so this asks the same
   * question the encoder asked: a file whose sound could only be inferred from the
   * container, and never heard, does not count as proved.
   */
  const videoAudible = exportState.phase !== 'done' || audioProved(exportState.result);

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
    // The encoder refuses to return a file it could not hear, so this is the second lock
    // on the same door rather than the first. It is here because a silent upload is the
    // failure that looks like a success, and a file that reached this point unproven
    // should leave through an explanation, not through the downloads folder.
    if (!audioProved(exportState.result)) {
      setShareNotice(
        'This video came out without audible sound, so it was not saved. Generate it again.',
      );
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

  /**
   * Hand the real file to the OS share sheet.
   *
   * Where the browser cannot take a file, the video is saved instead and the message
   * says so — nothing here claims to have posted anything anywhere.
   */
  const share = useCallback(async () => {
    if (!videoFile) {
      setShareNotice('There is no video yet. Generate one first.');
      return;
    }
    if (!videoAudible) {
      setShareNotice(
        'This video came out without audible sound, so it was not shared. Generate it again.',
      );
      return;
    }
    const blocked = describeShareBlock(videoFile);
    if (blocked === 'too-large') {
      setShareNotice(`This video is too large for your browser to share directly. ${DOWNLOAD_INSTEAD}`);
      return;
    }
    if (blocked === 'unsupported') {
      setShareSupported(false);
      if (saveVideo()) {
        setShareNotice(
          'This browser cannot pass a file to another app, so the MP4 was downloaded instead. Upload it from there.',
        );
      }
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
        setShareSupported(false);
        setShareNotice(DOWNLOAD_INSTEAD);
        break;
      case 'failed':
        setShareNotice(`Sharing failed. ${DOWNLOAD_INSTEAD}`);
        break;
    }
  }, [saveVideo, videoAudible, videoFile]);

  const copyLink = useCallback(async () => {
    const copied = await copyText(siteUrl());
    setShareNotice(
      copied ? 'GLASKO link copied.' : 'The clipboard is blocked in this browser. Copy the address bar instead.',
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
        {/*
         * The header wordmark. The PNG is transparent and its own artwork is warm bone
         * over gold, so it sits on --color-ink without a plate behind it.
         *
         * width/height are the file's real pixels (787x140): together with `h-auto`
         * they lock the aspect ratio — the logo can only scale, never stretch — and
         * reserve the row before the image arrives so the headline below does not jump.
         * `max-w-*` caps it well under the headline at every breakpoint; the source is
         * ~2.6x the widest rendered size, so it stays sharp on retina phones too.
         *
         * The account controls share this row. They are an offer, not a gate: nothing
         * below this line asks whether anyone is logged in.
         */}
        <div className="flex items-start justify-between gap-4">
          <img
            src="/glasko-logo.png"
            alt="GLASKO"
            width={787}
            height={140}
            decoding="async"
            fetchPriority="high"
            className="block h-auto w-full max-w-[220px] sm:max-w-[268px] lg:max-w-[300px]"
          />
          <AccountNav />
        </div>
        <h1 className="mt-7 max-w-xl font-display text-[2.6rem] leading-[1.04] tracking-[-0.015em] sm:text-6xl">
          Turn your voice into
          <br />
          social video.
        </h1>
        <p className="mt-5 max-w-md text-[0.95rem] leading-relaxed text-ash">
          Record or upload a voice message, pick a backdrop, a waveform, a music bed and
          subtitles, and export an MP4 built for TikTok, Reels, Shorts and the feed. The video is
          rendered in this browser tab — audio only leaves your device if you ask for subtitles.
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
          <PicturePanel
            settings={picture}
            imageName={pictureImage?.name ?? null}
            backdropName={background.kind === 'image' ? image?.name ?? null : null}
            onSettings={setPicture}
            onImage={handlePictureImage}
            onRemove={removePictureImage}
            onError={setNotice}
          />
          <HeadlinePanel settings={headline} onSettings={setHeadline} />
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
          <SubtitlePanel
            settings={subtitles}
            cues={cues}
            detected={detected}
            status={subtitleStatus}
            ready={Boolean(source) && !decoding}
            duration={source?.analysis.duration ?? 0}
            onSettings={applySubtitleSettings}
            onGenerate={generateSubtitles}
            onCancel={cancelSubtitles}
            onEditCue={editCue}
            onClear={clearSubtitles}
            onDownload={downloadSubtitles}
          />
          <FormatPanel
            format={format}
            watermark={watermark}
            onFormat={setFormatId}
            onWatermark={setWatermark}
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
            format={format}
            state={exportState}
            onGenerate={generate}
            onCancel={cancel}
            diagnostics={showDiagnostics}
            forcedPipeline={forcedPipeline}
            onForcePipeline={setForcedPipeline}
          />

          {exportState.phase === 'done' && (
            <SharePanel
              videoUrl={videoUrl}
              sizeBytes={exportState.result.blob.size}
              filename={exportState.filename}
              format={format}
              fileSharingSupported={fileSharingSupported}
              audible={videoAudible}
              notice={shareNotice}
              onShare={share}
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
