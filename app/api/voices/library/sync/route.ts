// POST /api/voices/library/sync
//   Re-fetches every public shared voice from ElevenLabs and writes the
//   result to Supabase at global/voice_library.json. Takes ~60–90 seconds
//   (11k+ voices across ~120 pages of 100) so it's gated behind an explicit
//   user click, never called automatically.
//
// The cached JSON is what /api/voices/library (GET) reads, so a sync is
// needed after ElevenLabs adds new voices. Idempotent — overwrites the
// same Supabase object every time.

import { writeJson } from '@/app/lib/blob';
import { LIBRARY_PATH, type LibraryVoice, type VoiceLibrary } from '@/app/lib/voiceLibrary';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const XI = 'https://api.elevenlabs.io';

export async function POST() {
  try {
    const KEY = process.env.ELEVENLABS_API_KEY;
    if (!KEY) {
      return Response.json({ error: 'ELEVENLABS_API_KEY missing' }, { status: 500 });
    }
    const voices: LibraryVoice[] = [];
    let page = 0;
    let hasMore = true;
    let total_count: number | null = null;
    // Vercel caps serverless at maxDuration; budget the loop so we always
    // write what we collected even if ElevenLabs is slow on a particular
    // page. 280s soft limit, 5s safety margin before the 300s hard cap.
    const deadline = Date.now() + 280_000;
    while (hasMore && Date.now() < deadline && page < 200) {
      const url = `${XI}/v1/shared-voices?page_size=100&page=${page}`;
      const r = await fetch(url, { headers: { 'xi-api-key': KEY } });
      if (!r.ok) {
        // One retry with a short back-off; skip on repeat failure so a
        // single flaky page doesn't poison the whole sync.
        await new Promise((s) => setTimeout(s, 1500));
        const r2 = await fetch(url, { headers: { 'xi-api-key': KEY } });
        if (!r2.ok) {
          page++;
          continue;
        }
        const d = await r2.json();
        mergePage(voices, d);
        hasMore = !!d.has_more;
        total_count = d.total_count ?? total_count;
      } else {
        const d = await r.json();
        mergePage(voices, d);
        hasMore = !!d.has_more;
        total_count = d.total_count ?? total_count;
      }
      page++;
    }

    const doc: VoiceLibrary = {
      synced_at: new Date().toISOString(),
      count: voices.length,
      voices,
    };
    await writeJson(LIBRARY_PATH, doc);

    return Response.json({
      ok: true,
      count: voices.length,
      reported_total: total_count,
      pages_fetched: page,
      hit_deadline: hasMore,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

function mergePage(out: LibraryVoice[], d: any): void {
  for (const v of d.voices || []) {
    out.push({
      voice_id: v.voice_id,
      name: v.name,
      description: v.description || '',
      category: v.category || '',
      gender: v.gender || '',
      age: v.age || '',
      accent: v.accent || '',
      use_case: v.use_case || '',
      descriptive: v.descriptive || '',
      language: v.language || '',
      locale: v.locale || '',
      preview_url: v.preview_url || '',
      public_owner_id: v.public_owner_id,
      featured: !!v.featured,
      cloned_by_count: v.cloned_by_count || 0,
    });
  }
}
