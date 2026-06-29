// POST /api/episodes/{id}/move { to_series_id }
//   Reassigns an episode to a different series. No storage move — the
//   project folder stays at `projects/{id}/` — only the index files and
//   the ProjectMeta.series_id pointer get rewritten. This is why the
//   additive refactor can move episodes between series instantly.

import { getMeta, putMeta, getSeriesMeta, putSeriesMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id: episodeId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const toSeriesId = String(body?.to_series_id || '').trim();
    if (!toSeriesId) {
      return Response.json({ error: 'to_series_id required' }, { status: 400 });
    }

    const episode = await getMeta(episodeId);
    if (!episode) return Response.json({ error: 'episode not found' }, { status: 404 });
    const fromSeriesId = episode.series_id;
    if (fromSeriesId === toSeriesId) {
      return Response.json({ ok: true, note: 'already in target series' });
    }

    const target = await getSeriesMeta(toSeriesId);
    if (!target) return Response.json({ error: 'target series not found' }, { status: 404 });

    // Remove from old index (non-fatal if missing).
    if (fromSeriesId) {
      const from = await getSeriesMeta(fromSeriesId);
      if (from) {
        from.episode_ids = from.episode_ids.filter((x) => x !== episodeId);
        await putSeriesMeta(from);
      }
    }

    // Append to new index (deduped).
    if (!target.episode_ids.includes(episodeId)) {
      target.episode_ids.push(episodeId);
      await putSeriesMeta(target);
    }

    // Update the episode's pointer + number.
    episode.series_id = toSeriesId;
    episode.episode_number = target.episode_ids.indexOf(episodeId) + 1;
    episode.updated_at = new Date().toISOString();
    await putMeta(episode);

    return Response.json({ ok: true, episode });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
