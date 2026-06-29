// GET  /api/projects/{id}/prompts             -> PromptsMap
// PUT  /api/projects/{id}/prompts {seg_id,...} -> upsert one segment's prompt
// POST /api/projects/{id}/prompts {bulk:true, prompts:{...}, replace?:bool}
//      merge (default) or replace the whole map

import { getPrompts, putPrompts, type PromptsMap, type PromptEntry } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const p = await getPrompts(id);
    return Response.json({ prompts: p }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const seg = String(body?.seg_id || '').trim();
    if (!seg) return Response.json({ error: 'seg_id required' }, { status: 400 });
    const entry: PromptEntry = {
      prompt: String(body?.prompt || '').trim(),
      narration: body?.narration ? String(body.narration) : undefined,
      wardrobe: body?.wardrobe ? String(body.wardrobe) : undefined,
    };
    const prompts = await getPrompts(id);
    const prior = prompts[seg];
    prompts[seg] = entry;
    await putPrompts(id, prompts);
    await appendChange(id, {
      type: 'prompt.update',
      seg_id: seg,
      before: prior ? { prompt: prior.prompt, wardrobe: prior.wardrobe } : undefined,
      after: { prompt: entry.prompt, wardrobe: entry.wardrobe },
      meta: {
        char_delta: entry.prompt.length - (prior?.prompt.length ?? 0),
      },
    });
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (!body?.bulk || typeof body?.prompts !== 'object') {
      return Response.json({ error: 'bulk=true and prompts{} required' }, { status: 400 });
    }
    const incoming = body.prompts as PromptsMap;
    const existing = body.replace ? {} : await getPrompts(id);
    const merged: PromptsMap = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      if (!v || typeof v.prompt !== 'string') continue;
      merged[k] = {
        prompt: v.prompt,
        narration: v.narration,
        wardrobe: v.wardrobe,
      };
    }
    await putPrompts(id, merged);
    return Response.json({ ok: true, count: Object.keys(merged).length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
