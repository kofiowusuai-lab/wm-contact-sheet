// GET    /api/series/{id}              -> series meta + hydrated episodes
// PATCH  /api/series/{id} {title?,description?}  -> rename / edit meta
// DELETE /api/series/{id}[?cascade=1]   -> remove series (cascade deletes episodes too)

import {
  getSeriesMeta,
  putSeriesMeta,
  removeSeriesMeta,
  getMeta,
  deleteProject,
  type ProjectMeta,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const series = await getSeriesMeta(id);
    if (!series) return Response.json({ error: 'not_found' }, { status: 404 });
    // Hydrate episode metas. Filter out any episode_ids that have since
    // been deleted at the project layer so the UI doesn't render zombies.
    const episodes = (
      await Promise.all(series.episode_ids.map((epId) => getMeta(epId)))
    ).filter((m): m is ProjectMeta => m !== null);
    // Sort by explicit episode_number when present; fall back to the
    // order they appear in series.episode_ids.
    const order = new Map(series.episode_ids.map((eid, i) => [eid, i]));
    episodes.sort((a, b) => {
      const an = a.episode_number ?? order.get(a.id) ?? 0;
      const bn = b.episode_number ?? order.get(b.id) ?? 0;
      return an - bn;
    });
    return Response.json(
      { series, episodes },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const series = await getSeriesMeta(id);
    if (!series) return Response.json({ error: 'not_found' }, { status: 404 });
    let dirty = false;
    if (typeof body?.title === 'string') {
      const t = body.title.trim();
      if (!t) return Response.json({ error: 'title cannot be empty' }, { status: 400 });
      if (t.length > 120) {
        return Response.json({ error: 'title must be 120 characters or fewer' }, { status: 400 });
      }
      series.title = t;
      dirty = true;
    }
    if (typeof body?.description === 'string') {
      series.description = body.description.trim() || undefined;
      dirty = true;
    }
    if (!dirty) return Response.json({ error: 'no supported fields in body' }, { status: 400 });
    await putSeriesMeta(series);
    return Response.json({ ok: true, series });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const cascade = url.searchParams.get('cascade') === '1';
    const series = await getSeriesMeta(id);
    if (!series) return Response.json({ error: 'not_found' }, { status: 404 });
    if (series.episode_ids.length > 0 && !cascade) {
      return Response.json(
        {
          error: `series '${id}' has ${series.episode_ids.length} episode(s). Pass ?cascade=1 to delete them too.`,
        },
        { status: 409 },
      );
    }
    let removedEpisodes = 0;
    if (cascade) {
      for (const epId of series.episode_ids) {
        try {
          const n = await deleteProject(epId);
          if (n > 0) removedEpisodes++;
        } catch {
          /* non-fatal — keep deleting the rest */
        }
      }
    }
    await removeSeriesMeta(id);
    return Response.json({ ok: true, removed_series: id, removed_episodes: removedEpisodes });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
