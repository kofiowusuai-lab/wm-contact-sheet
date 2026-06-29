// POST /api/projects/{id}/parse-prompts { text }
//   Parses the "VO_045 — ..." mass-import format, upserts into prompts.json.
//   Reports which IDs aren't in the current timeline so the UI can warn.

import {
  getTimeline,
  putTimeline,
  getPrompts,
  putPrompts,
  getMergedLocations,
} from '@/app/lib/blob';
import { parsePrompts } from '@/app/lib/parseScript';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const text = String(body?.text || '');
    if (!text.trim()) return Response.json({ error: 'text required' }, { status: 400 });

    const blocks = parsePrompts(text);
    const timeline = (await getTimeline(id)) ?? [];
    const known = new Set(timeline.map((s) => s.id));
    // Merged location catalog (own + subscribed library) so we know which
    // Location: tags in the paste map to real, stampable ids.
    const locationCatalog = new Set(
      (await getMergedLocations(id).catch(() => [])).map((l) => l.id),
    );
    // Segments that gain a location stamp from this paste. Written back below
    // if any change.
    const segLocationPatches: Record<string, string | null> = {};
    // When `replace: true`, drop every existing prompt and install only the
    // blocks parsed from this paste. Eliminates orphans left over from
    // earlier attempts whose segment IDs don't exist in the current timeline.
    const replace = Boolean(body?.replace);
    const prompts = replace ? {} : await getPrompts(id);
    const priorCount = replace ? (await getPrompts(id).then((p) => Object.keys(p).length).catch(() => 0)) : 0;
    const unknown: string[] = [];

    for (const b of blocks) {
      prompts[b.id] = { prompt: b.prompt, narration: b.narration, wardrobe: b.wardrobe };
      if (!known.has(b.id)) unknown.push(b.id);
      // Stamp location tag onto the segment if the paste provided one that
      // matches a known catalog entry. Unknown tags are ignored silently —
      // operator can still hand-pick in the row.
      if (b.location && known.has(b.id)) {
        if (locationCatalog.has(b.location)) {
          segLocationPatches[b.id] = b.location;
        }
      }
    }
    await putPrompts(id, prompts);

    if (Object.keys(segLocationPatches).length > 0 && timeline.length > 0) {
      const patched = timeline.map((s) =>
        segLocationPatches[s.id] !== undefined
          ? { ...s, location: segLocationPatches[s.id] as string }
          : s,
      );
      await putTimeline(id, patched);
    }

    return Response.json({
      ok: true,
      parsed: blocks.length,
      unknown_ids: unknown,
      total_prompts: Object.keys(prompts).length,
      replaced: replace,
      dropped: replace ? Math.max(0, priorCount - blocks.length) : 0,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
