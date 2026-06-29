// GET /api/projects/{id}/voiceovers
//   -> { generations: VoiceoverGeneration[] }
//   Lists every voice that has been used to generate a voiceover for this
//   project. Fuels the blue "GENERATED" badge on the voice picker.

import { getVoiceoverGenerations } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const doc = await getVoiceoverGenerations(id);
    return Response.json(doc, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
