/**
 * The background-music library: the built-in catalogue plus the rules for
 * user-supplied tracks.
 *
 * The catalogue itself lives in `public/music/library.json` so the audio files and
 * the metadata that describes them sit together in one folder. That file is
 * written by `scripts/generate-music.js` (`npm run music:build`), which
 * synthesises every built-in track from oscillators — no samples, no third-party
 * recordings — so the whole library ships as CC0 public domain. Adding a properly
 * licensed third-party track means dropping the file into `public/music/` and
 * adding an entry to that JSON by hand.
 */

import libraryData from '@/public/music/library.json';

export const MUSIC_CATEGORIES = [
  'Inspirational',
  'Calm',
  'Cinematic',
  'Energetic',
  'Business',
  'Ambient',
] as const;

export type MusicCategory = (typeof MUSIC_CATEGORIES)[number];

export interface MusicTrack {
  id: string;
  title: string;
  category: MusicCategory;
  /** Path under `public/`, e.g. `/music/soft-morning.mp3`. */
  src: string;
  duration: number;
  artist: string;
  license: string;
  /** One-line description shown on the card. */
  mood?: string;
}

/** What the app holds once a track — built-in or uploaded — has been decoded. */
export interface SelectedMusic {
  id: string;
  title: string;
  /** Built-in category, or `'Your upload'` for a user file. */
  category: string;
  artist: string;
  license: string;
  duration: number;
  /** Playable URL: a static path for built-ins, an object URL for uploads. */
  url: string;
  origin: 'library' | 'upload';
  buffer: AudioBuffer;
}

function isCategory(value: unknown): value is MusicCategory {
  return typeof value === 'string' && (MUSIC_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Read the JSON defensively. A hand-edited entry with a category that is not in
 * the list above should drop out of the picker rather than break the page.
 */
export const MUSIC_LIBRARY: MusicTrack[] = (libraryData as unknown[]).flatMap((entry) => {
  const track = entry as Partial<MusicTrack>;
  if (!track.id || !track.title || !track.src || !isCategory(track.category)) return [];
  return [
    {
      id: track.id,
      title: track.title,
      category: track.category,
      src: track.src,
      duration: typeof track.duration === 'number' ? track.duration : 0,
      artist: track.artist ?? 'Unknown',
      license: track.license ?? 'Unspecified',
      mood: track.mood,
    },
  ];
});

/** Categories that actually have tracks, in the canonical order. */
export const POPULATED_CATEGORIES: MusicCategory[] = MUSIC_CATEGORIES.filter((category) =>
  MUSIC_LIBRARY.some((track) => track.category === category),
);

export const MAX_MUSIC_BYTES = 20 * 1024 * 1024;

/** Formats the picker accepts. Kept narrow on purpose — these four decode everywhere. */
export const MUSIC_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac'] as const;
export const MUSIC_FORMAT_LABEL = 'MP3, WAV, M4A or AAC · up to 20 MB';

const MUSIC_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/aacp',
];

export const MUSIC_UPLOAD_ACCEPT = `.mp3,.wav,.m4a,.aac,${MUSIC_MIME_TYPES.join(',')}`;

/**
 * Returns a message to show the user, or null when the file is acceptable.
 *
 * The extension is checked as well as the MIME type because browsers report m4a
 * and aac inconsistently — Safari sends `audio/x-m4a`, some Android pickers send
 * an empty string.
 */
export function describeMusicFileProblem(file: File): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const knownExtension = (MUSIC_EXTENSIONS as readonly string[]).includes(extension);
  const knownType = MUSIC_MIME_TYPES.includes(file.type.toLowerCase());
  if (!knownExtension && !knownType) {
    return 'That file is not a supported music format. Use MP3, WAV, M4A or AAC.';
  }
  if (file.size > MAX_MUSIC_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);
    return `That track is ${megabytes} MB. Keep music under 20 MB.`;
  }
  if (file.size === 0) return 'That file is empty.';
  return null;
}

export const DEFAULT_VOICE_VOLUME = 1;
export const DEFAULT_MUSIC_VOLUME = 0.15;

export interface MusicCoverage {
  mode: 'loop' | 'trim' | 'exact';
  /** How many times the track plays, counting the partial last pass. */
  loops: number;
}

/**
 * How the track will be fitted to the voice: looped when it is shorter, trimmed
 * when it is longer. Both happen automatically at export; this only describes it
 * so the panel can say which one applies.
 */
export function musicCoverage(musicDuration: number, voiceDuration: number): MusicCoverage {
  if (musicDuration <= 0 || voiceDuration <= 0) return { mode: 'exact', loops: 1 };
  const ratio = voiceDuration / musicDuration;
  if (ratio > 1.02) return { mode: 'loop', loops: Math.ceil(ratio) };
  if (ratio < 0.98) return { mode: 'trim', loops: 1 };
  return { mode: 'exact', loops: 1 };
}
