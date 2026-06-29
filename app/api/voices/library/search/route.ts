// POST /api/voices/library/search  { query }
//
// Natural-language search over the cached library. Gemini reads the query
// and returns a structured filter ({ gender?, age?, accent?, use_case?,
// descriptive?, language?, keywords[] }). That filter then runs through
// the same scorer the keyword endpoint uses, giving the user "describe
// what you want → get the right voices" without forcing them to know the
// exact label strings ElevenLabs uses internally.
//
// If Gemini is unavailable or returns garbage we fall back to plain
// keyword search so the button never silently does nothing.

import { readJson } from '@/app/lib/blob';
import {
  LIBRARY_PATH,
  passesFilters,
  scoreVoice,
  type LibraryVoice,
  type VoiceLibrary,
} from '@/app/lib/voiceLibrary';

export const runtime = 'nodejs';
export const maxDuration = 20;
export const dynamic = 'force-dynamic';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

type ParsedQuery = {
  gender?: string;
  age?: string;
  accent?: string;
  use_case?: string;
  descriptive?: string;
  language?: string;
  keywords?: string[];
};

const EXTRACT_PROMPT = `You translate a short human voice request into a structured filter over the ElevenLabs voice library.

Return ONLY a JSON object with these optional fields:
- gender: one of ["male", "female", "neutral"] or omit
- age: one of ["young", "middle_aged", "old"] or omit
- accent: a lowercase accent name like "american", "british", "indian", "african_american", "australian", "irish" — only if explicitly requested, else omit
- use_case: one of ["narrative_story", "informative_educational", "conversational", "characters_animation", "advertisement", "entertainment_tv", "social_media", "meditation"] or omit
- descriptive: one of ["calm", "warm", "confident", "raspy", "deep", "friendly", "authoritative", "sad", "excited", "whispery", "gentle", "professional", "serious"] or omit
- language: 2-letter ISO code like "en", "ja", "es" — only if the user specifies a non-English language, else omit
- keywords: array of 1–3 short free-text terms from the user's phrasing that don't map to any label above

No commentary, no markdown fences, no extra keys. Just the JSON object.

User request: `;

async function parseWithGemini(query: string): Promise<ParsedQuery | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${GEMINI_URL}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: EXTRACT_PROMPT + query }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    if (!r.ok) return null;
    const data: any = await r.json();
    const text = ((data?.candidates?.[0]?.content?.parts ?? []) as any[])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    const parsed = JSON.parse(text) as ParsedQuery;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const query = String(body?.query || '').trim();
    const limit = Math.min(200, Math.max(1, Number(body?.limit) || 30));
    if (!query) {
      return Response.json({ error: 'query required' }, { status: 400 });
    }
    const lib = await readJson<VoiceLibrary>(LIBRARY_PATH);
    if (!lib) {
      return Response.json(
        { error: 'library not synced yet', voices: [] },
        { status: 503 },
      );
    }

    const parsed = (await parseWithGemini(query)) ?? {};
    const filters = {
      gender: parsed.gender || '',
      age: parsed.age || '',
      accent: parsed.accent || '',
      use_case: parsed.use_case || '',
      language: parsed.language || '',
      category: '',
    };

    // Keyword pool = Gemini keywords + every word from the raw query. We
    // keep the raw words so the scorer still ranks by name hits even when
    // Gemini already absorbed the same concept into a structured filter
    // (e.g. the user typed "deep male" — gender=male, descriptive=deep,
    // keywords=[deep, male] — and "Lamin - Deep" still scores via the
    // name substring match).
    const rawTerms = query.split(/\s+/).filter(Boolean);
    const terms = Array.from(
      new Set([...(parsed.keywords ?? []), ...rawTerms, parsed.descriptive].filter(Boolean) as string[]),
    );

    const passing = lib.voices.filter((v) => passesFilters(v, filters));
    const scored = passing
      .map((v) => ({ v, s: scoreVoice(v, terms) }))
      .filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    // If the Gemini-parsed filters narrowed too hard (0 hits after scoring),
    // relax: keep the structural filters but show top results by popularity
    // so the user always sees SOMETHING actionable.
    let picked: LibraryVoice[] = scored.slice(0, limit).map((x) => x.v);
    let fallback = false;
    if (picked.length === 0) {
      fallback = true;
      picked = passing
        .slice()
        .sort((a, b) => b.cloned_by_count - a.cloned_by_count)
        .slice(0, limit);
    }

    return Response.json({
      synced_at: lib.synced_at,
      library_total: lib.count,
      parsed,
      filters,
      terms,
      total_matching: fallback ? passing.length : scored.length,
      fallback,
      voices: picked,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
