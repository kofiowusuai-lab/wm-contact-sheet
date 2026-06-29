// POST /api/series/{id}/episodes { title }
//   Creates a new episode (a project, under the hood) and adds its id to
//   the parent series' episode_ids. Episode id is slugged from title with
//   the series id as a prefix to avoid collisions between series that
//   reuse episode names (e.g. "pilot"). Retries the series update once if
//   the read-modify-write races with another concurrent creator.

import {
  getSeriesMeta,
  putSeriesMeta,
  getMeta,
  putMeta,
  type ProjectMeta,
} from '@/app/lib/blob';
import { slug } from '@/app/lib/slug';

export const runtime = 'nodejs';
// Bumped from 15 because cold-start Supabase reads plus the slug-collision
// loop can push the lambda past the Vercel default on large series; a
// single 30-second ceiling is well within Hobby limits and prevents the
// orchestrator from falsely reporting "create episode failed" when it just
// needed a few more seconds.
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id: seriesId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const title = String(body?.title || '').trim();
    if (!title) return Response.json({ error: 'title required' }, { status: 400 });

    const series = await getSeriesMeta(seriesId);
    if (!series) return Response.json({ error: 'series not found' }, { status: 404 });

    // Episode id = `{series_id}__{slug(title)}`. Two underscores so a
    // series id that happens to contain `_` stays unambiguously split.
    const base = slug(title);
    if (!base) return Response.json({ error: 'title produced an empty slug' }, { status: 400 });
    let episodeId = `${seriesId}__${base}`.slice(0, 60);
    // Resolve collisions by appending _2, _3, … so we never overwrite an
    // existing project's storage.
    let n = 2;
    while (await getMeta(episodeId)) {
      episodeId = `${seriesId}__${base}_${n}`.slice(0, 60);
      n++;
      if (n > 999) {
        return Response.json({ error: 'could not allocate unique episode id' }, { status: 500 });
      }
    }

    const now = new Date().toISOString();
    const episode: ProjectMeta = {
      id: episodeId,
      title,
      series_id: seriesId,
      episode_number: series.episode_ids.length + 1,
      created_at: now,
      updated_at: now,
    };
    await putMeta(episode);

    // Read-modify-write on the series index. One retry on conflict —
    // Supabase has no conditional PUT so optimistic is the best we can
    // do (matches recordVoiceoverGeneration's pattern).
    const appendOnce = async (): Promise<{ ok: boolean; dup: boolean }> => {
      const fresh = await getSeriesMeta(seriesId);
      if (!fresh) return { ok: false, dup: false };
      if (fresh.episode_ids.includes(episodeId)) return { ok: true, dup: true };
      fresh.episode_ids.push(episodeId);
      await putSeriesMeta(fresh);
      return { ok: true, dup: false };
    };
    let result = await appendOnce();
    if (!result.ok) result = await appendOnce();

    return Response.json({ ok: true, episode });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
