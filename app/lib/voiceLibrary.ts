// Shared types + small helpers for the cached ElevenLabs shared-voice
// library. The cache lives in Supabase at global/voice_library.json. Sync
// is on-demand via /api/voices/library/sync; reads go through the fetch +
// filter endpoints in app/api/voices/library/*.
//
// We keep a flat structure so the whole thing loads in one round-trip and
// filtering stays cheap even at ~12k voices. Fields mirror what ElevenLabs
// exposes on /v1/shared-voices so "categorise by description" means "search
// across name + description + the labels ElevenLabs already attaches".

export type LibraryVoice = {
  voice_id: string;
  name: string;
  description: string;
  category: string;       // professional | high_quality | generated | …
  gender: string;         // male | female | neutral | ''
  age: string;            // young | middle_aged | old | ''
  accent: string;         // american | british | african_american | kansai …
  use_case: string;       // narration | informative_educational | characters …
  descriptive: string;    // calm | warm | confident | raspy …
  language: string;       // en | ja | es …
  locale: string;         // en-US | en-GB …
  preview_url: string;
  public_owner_id: string;
  featured: boolean;
  cloned_by_count: number;
};

export type VoiceLibrary = {
  synced_at: string;
  count: number;
  voices: LibraryVoice[];
};

// Normalise user-supplied filter strings before matching against cached
// fields. Both sides get lower-cased and spaces collapsed so "African
// American" and "african_american" match.
export function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '_');
}

// Score a voice against a keyword query. Exact-name hit > label hit >
// description substring hit. Used to rank the top-N on the server so the
// UI doesn't have to ship 12k rows every time.
export function scoreVoice(v: LibraryVoice, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = [
    v.name,
    v.description,
    v.gender,
    v.age,
    v.accent,
    v.use_case,
    v.descriptive,
    v.category,
    v.language,
  ].join(' ').toLowerCase();
  let score = 0;
  for (const t of terms) {
    const term = t.toLowerCase();
    if (!term) continue;
    if (v.name.toLowerCase() === term) score += 100;
    else if (v.name.toLowerCase().includes(term)) score += 20;
    if (v.description.toLowerCase().includes(term)) score += 6;
    // Label fields are high-signal: if the user says "warm" and the voice
    // has descriptive="warm", that's almost certainly the right match.
    for (const f of [v.gender, v.age, v.accent, v.use_case, v.descriptive, v.category]) {
      if (norm(f) === norm(term)) score += 12;
    }
    if (haystack.includes(term)) score += 1;
  }
  // Featured/popular tiebreaker so identical scores surface the voices
  // other users have already cloned — usually a quality signal.
  score += Math.min(5, Math.log10(Math.max(1, v.cloned_by_count)));
  if (v.featured) score += 2;
  return score;
}

export function passesFilters(
  v: LibraryVoice,
  f: {
    gender?: string;
    age?: string;
    accent?: string;
    use_case?: string;
    language?: string;
    category?: string;
  },
): boolean {
  if (f.gender && norm(v.gender) !== norm(f.gender)) return false;
  if (f.age && norm(v.age) !== norm(f.age)) return false;
  if (f.accent && norm(v.accent) !== norm(f.accent)) return false;
  if (f.use_case && norm(v.use_case) !== norm(f.use_case)) return false;
  if (f.language && norm(v.language) !== norm(f.language)) return false;
  if (f.category && norm(v.category) !== norm(f.category)) return false;
  return true;
}

export const LIBRARY_PATH = 'global/voice_library.json';
