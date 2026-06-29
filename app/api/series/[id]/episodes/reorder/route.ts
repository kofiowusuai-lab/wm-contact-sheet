// POST /api/series/{id}/episodes/reorder { episode_ids: string[] }
//   Reorders episodes within a series. Writes the new order to
//   series.episode_ids AND rewrites episode_number on every affected
//   ProjectMeta so dropdown ordering + badge numbers stay in sync.
//   Extra ids (not in the current series) are rejected to prevent
//   accidental reassignment — use /api/episodes/{id}/move for that.

import { getSeriesMeta, putSeriesMeta, getMeta, putMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id: seriesId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const next = Array.isArray(body?.episode_ids) ? (body.episode_ids as string[]) : null;
    if (!next) return Response.json({ error: 'episode_ids array required' }, { status: 400 });

    const series = await getSeriesMeta(seriesId);
    if (!series) return Response.json({ error: 'series not found' }, { status: 404 });

    const current = new Set(series.episode_ids);
    if (next.length !== series.episode_ids.length) {
      return Response.json(
        { error: 'episode_ids length mismatch — use /move to add/remove' },
        { status: 400 },
      );
    }
    for (const eid of next) {
      if (!current.has(eid)) {
        return Response.json({ error: `episode '${eid}' not in this series` }, { status: 400 });
      }
    }

    series.episode_ids = next;
    await putSeriesMeta(series);

    // Rewrite episode_number on each affected episode so the dropdown
    // numbering matches the new order.
    for (let i = 0; i < next.length; i++) {
      const ep = await getMeta(next[i]);
      if (!ep) continue;
      if (ep.episode_number === i + 1) continue;
      ep.episode_number = i + 1;
      ep.updated_at = new Date().toISOString();
      await putMeta(ep);
    }

    return Response.json({ ok: true, series });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
