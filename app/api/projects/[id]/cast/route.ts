// GET  /api/projects/{id}/cast          -> CastDoc (narrator + characters)
// PUT  /api/projects/{id}/cast  {cast}  -> upsert the episode's cast map
//
// cast.json lives alongside meta.json inside each episode's Supabase
// folder. It's read by the tunnel when it generates voiceover.mp3 so
// speaker-tagged lines in the script can be routed to the right voice.
// Missing cast.json → pipeline falls back to the single meta.voice_id
// narrator for everything (backwards-compatible).

import { getCast, putCast, type CastDoc } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const cast = (await getCast(id)) ?? {
      narrator: null,
      characters: {},
      updated_at: new Date().toISOString(),
    };
    return Response.json(cast, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'JSON body required' }, { status: 400 });
    }
    const doc: CastDoc = {
      narrator: (body.narrator && typeof body.narrator === 'object') ? {
        voice_id: String(body.narrator.voice_id || '').trim(),
        voice_name: String(body.narrator.voice_name || '').trim(),
      } : null,
      characters: {},
      updated_at: new Date().toISOString(),
    };
    // Normalise character slot keys to uppercase + validate voice_id shape.
    const incoming = (body.characters && typeof body.characters === 'object')
      ? body.characters as Record<string, any>
      : {};
    for (const [rawName, entry] of Object.entries(incoming)) {
      const name = String(rawName).trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_-]*$/.test(name)) continue; // silently drop bad keys
      if (!entry) { doc.characters[name] = null; continue; }
      const voice_id = String((entry as any).voice_id || '').trim();
      const voice_name = String((entry as any).voice_name || '').trim();
      if (!voice_id) { doc.characters[name] = null; continue; }
      doc.characters[name] = { voice_id, voice_name };
    }
    await putCast(id, doc);
    return Response.json({ ok: true, cast: doc });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
