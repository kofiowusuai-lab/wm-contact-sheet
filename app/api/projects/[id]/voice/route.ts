// PUT /api/projects/{id}/voice { voice_id, voice_name? }
//
// Persists the user's voice choice to meta.json without copying any mp3.
// Used when the picker changes to a voice that hasn't been generated yet —
// without this, the selection would only live in local React state and a
// page refresh would reset to whatever the last generation used (or to an
// arbitrary voices[0] default). The TTS / select endpoints already handle
// their own meta writes, so callers only hit this one for the pure "I want
// this voice next time I regenerate" case.

import { getMeta, putMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const voice_id = String(body?.voice_id || '').trim();
    const voice_name = String(body?.voice_name || '').trim();
    if (!voice_id || !/^[A-Za-z0-9_\-]+$/.test(voice_id)) {
      return Response.json({ error: 'voice_id required' }, { status: 400 });
    }
    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });
    meta.voice_id = voice_id;
    if (voice_name) meta.voice_name = voice_name;
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);
    return Response.json({ ok: true, voice_id, voice_name: voice_name || null });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
