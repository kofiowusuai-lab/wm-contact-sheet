// POST /api/projects/{id}/voiceovers/select { voice_id }
//   Copies voiceovers/{voice_id}.mp3 to voiceover.mp3 (the active track)
//   and updates meta. Does NOT rebuild the timeline. Use when the user wants
//   to A/B between voices that have already been generated, without paying
//   for another TTS run.

import {
  copyVoiceoverToActive,
  getMeta,
  putMeta,
  getVoiceoverGenerations,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const voice_id = String(body?.voice_id || '').trim();
    if (!voice_id || !/^[A-Za-z0-9_\-]+$/.test(voice_id)) {
      return Response.json({ error: 'voice_id required' }, { status: 400 });
    }

    const url = await copyVoiceoverToActive(id, voice_id);
    if (!url) {
      return Response.json(
        { error: 'no stored voiceover for this voice — generate it first' },
        { status: 404 },
      );
    }

    // Keep meta in sync so the UI shows the right selected voice after refresh.
    const gens = (await getVoiceoverGenerations(id)).generations;
    const entry = gens.find((g) => g.voice_id === voice_id);
    const meta = await getMeta(id);
    if (meta) {
      meta.voice_id = voice_id;
      if (entry?.voice_name) meta.voice_name = entry.voice_name;
      if (entry?.model_id) meta.model_id = entry.model_id;
      // The copy just rewrote voiceover.mp3 to this voice's bytes.
      meta.active_voice_id = voice_id;
      meta.updated_at = new Date().toISOString();
      await putMeta(meta);
    }

    return Response.json({
      ok: true,
      audio_url: url,
      voice_id,
      voice_name: entry?.voice_name ?? null,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
