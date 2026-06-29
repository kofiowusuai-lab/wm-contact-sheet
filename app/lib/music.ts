// Background music settings follow the same shape + UX as SubtitleSettings:
// one globally selected track, a global enable toggle, and a per-segment
// disabledIds[] list for beats the user wants silent. Persisted to
// localStorage per-project (the Jamendo API is read-only and fast enough
// that we don't need to round-trip Supabase for every volume nudge).

export type BackgroundMusic = {
  enabled: boolean;
  /** Jamendo track id as a string (their ids are numeric but we store as
   *  string so future sources can coexist — e.g. pixabay:123). */
  track_id: string;
  title: string;
  artist: string;
  /** Direct MP3 stream URL from Jamendo's /tracks endpoint (`audio` field
   *  with `audioformat=mp32`). Hotlink-safe for preview + render mixing. */
  audio_url: string;
  /** Duration in seconds. Used to show a count-down next to the player and
   *  to decide when to loop vs trim during render. */
  duration: number;
  /** 0.0 – 1.0. 0.25 is a sensible default — music sits UNDER the voiceover,
   *  not competing with it. */
  volume: number;
  /** seg_ids where the music should NOT play (e.g. title cards where
   *  silence is intentional). Mirrors SubtitleSettings.disabledIds. */
  disabledIds: string[];
  /** Optional self-attribution string ("Track by Artist — Jamendo"). Not
   *  required by Jamendo's free-use terms but nice to have in the credits. */
  license_note?: string;
};

export const DEFAULT_MUSIC: BackgroundMusic = {
  enabled: false,
  track_id: '',
  title: '',
  artist: '',
  audio_url: '',
  duration: 0,
  volume: 0.25,
  disabledIds: [],
};

export function isMusicEnabledFor(
  segId: string,
  music: BackgroundMusic | null | undefined,
): boolean {
  if (!music || !music.enabled || !music.track_id) return false;
  return !music.disabledIds.includes(segId);
}

export function musicStorageKey(projectId: string): string {
  return `wm_music_${projectId}`;
}

// Tag presets surfaced in the UI filter chips. Jamendo tags are free-text,
// so this list is opinionated — curated for the narration/video-essay use
// case where we want atmosphere under a voiceover, not dance music. The
// free-text search handles the long tail (lofi, orchestral, synthwave, …).
export const MUSIC_MOOD_PRESETS = [
  { id: '', label: 'any mood' },
  { id: 'calm', label: 'calm' },
  { id: 'sad', label: 'sad' },
  { id: 'emotional', label: 'emotional' },
  { id: 'dramatic', label: 'dramatic' },
  { id: 'epic', label: 'epic' },
  { id: 'tense', label: 'tense' },
  { id: 'hopeful', label: 'hopeful' },
  { id: 'happy', label: 'happy' },
  { id: 'dark', label: 'dark' },
  { id: 'meditative', label: 'meditative' },
];

export const MUSIC_GENRE_PRESETS = [
  { id: '', label: 'any genre' },
  { id: 'cinematic', label: 'cinematic' },
  { id: 'ambient', label: 'ambient' },
  { id: 'classical', label: 'classical' },
  { id: 'electronic', label: 'electronic' },
  { id: 'lofi', label: 'lo-fi' },
  { id: 'piano', label: 'piano' },
  { id: 'orchestral', label: 'orchestral' },
  { id: 'acoustic', label: 'acoustic' },
  { id: 'jazz', label: 'jazz' },
];
