// GET /api/voices/library
//   ?q=<terms> &gender= &age= &accent= &use_case= &language= &category=
//   &limit=50 &offset=0
//
// Returns cached ElevenLabs shared voices filtered + ranked by match. The
// cache lives in Supabase at global/voice_library.json and is written by
// the sync route; the GET here is pure read + filter so it's cheap even
// when called on every keystroke.

import { readJson } from '@/app/lib/blob';
import {
  LIBRARY_PATH,
  passesFilters,
  scoreVoice,
  type LibraryVoice,
  type VoiceLibrary,
} from '@/app/lib/voiceLibrary';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const filters = {
      gender: url.searchParams.get('gender') || '',
      age: url.searchParams.get('age') || '',
      accent: url.searchParams.get('accent') || '',
      use_case: url.searchParams.get('use_case') || '',
      language: url.searchParams.get('language') || '',
      category: url.searchParams.get('category') || '',
    };

    const lib = await readJson<VoiceLibrary>(LIBRARY_PATH);
    if (!lib) {
      return Response.json(
        {
          error: 'library not synced yet — POST /api/voices/library/sync first',
          count: 0,
          voices: [],
        },
        { status: 503 },
      );
    }

    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    let filtered: LibraryVoice[] = lib.voices.filter((v) => passesFilters(v, filters));

    if (terms.length > 0) {
      const scored = filtered
        .map((v) => ({ v, s: scoreVoice(v, terms) }))
        .filter((x) => x.s > 0);
      scored.sort((a, b) => b.s - a.s);
      filtered = scored.map((x) => x.v);
    } else {
      // No query → show featured first, then by popularity. Gives users a
      // sensible default page of high-quality voices instead of whatever
      // happened to land first alphabetically.
      filtered.sort((a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return b.cloned_by_count - a.cloned_by_count;
      });
    }

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return Response.json({
      synced_at: lib.synced_at,
      library_total: lib.count,
      total_matching: total,
      offset,
      limit,
      voices: page,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
