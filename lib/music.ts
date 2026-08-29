/** User-upload rules and shared volume values for background music. */

/** What the app holds once the user's song has been decoded. */
export interface SelectedMusic {
  id: string;
  title: string;
  /** Display label for the user file. */
  category: string;
  artist: string;
  license: string;
  duration: number;
  /** Playable object URL for the local upload. */
  url: string;
  origin: 'upload';
  buffer: AudioBuffer;
}

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

/** One volume rule for slider input, live players and exported audio. */
export function normaliseVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

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
