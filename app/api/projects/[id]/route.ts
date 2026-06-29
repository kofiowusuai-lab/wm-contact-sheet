// GET    /api/projects/{id}  -> full state bundle
// DELETE /api/projects/{id}  -> removes every blob under projects/{id}/

import {
  getMeta,
  putMeta,
  getScript,
  getTimeline,
  getPrompts,
  getApprovals,
  getProtagonist,
  getRefs,
  putRefs,
  getVoiceoverUrl,
  getVoiceoverGenerations,
  getCast,
  deleteProject,
  getSeriesMeta,
  putSeriesMeta,
} from '@/app/lib/blob';
import { ASPECT_PRESETS } from '@/app/lib/aspectRatios';

export const runtime = 'nodejs';
// Bundle joins ~10 Supabase reads in one request. Cold-start Supabase
// sometimes lets a single blob read stall 10+ seconds, pushing the
// original 15s limit right to the edge. 30s gives the loader headroom
// without changing anything a healthy read hits.
export const maxDuration = 30;
// Every hit reads timeline.json + six other blobs straight from Supabase.
// We never want Vercel's edge to cache this response — a stale bundle is
// the difference between "all frames visible" and "frames mysteriously
// missing after a reconcile script ran". Force dynamic per request.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

// Race a blob read against a per-call timeout so one stalled Supabase
// read can't drag the whole bundle past the lambda's 30s ceiling. On
// timeout we return `fallback` (matches the absent-file semantics of
// every getter below) so the bundle shape stays consistent.
async function raceOrFallback<T>(
  p: Promise<T>,
  fallback: T,
  timeoutMs = 10_000,
): Promise<T> {
  return await Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const meta = await raceOrFallback(getMeta(id), null, 8_000);
    if (!meta) return Response.json({ error: 'not_found' }, { status: 404 });
    // Each getter already returns `null` / `[]` / `{}` when its file is
    // missing; raceOrFallback matches that so a 10s-stalled read looks
    // to the client like "no data yet" — the relevant panel just renders
    // empty instead of hanging the whole bundle.
    const [script, timeline, prompts, approvals, protagonist, characters, products, voiceover_url, voiceover_generations, cast] =
      await Promise.all([
        raceOrFallback(getScript(id), null),
        raceOrFallback(getTimeline(id), null),
        raceOrFallback(getPrompts(id), {} as Awaited<ReturnType<typeof getPrompts>>),
        raceOrFallback(getApprovals(id), { approved: [] } as Awaited<ReturnType<typeof getApprovals>>),
        raceOrFallback(getProtagonist(id), null),
        raceOrFallback(getRefs(id, 'characters'), { refs: [] } as Awaited<ReturnType<typeof getRefs>>),
        raceOrFallback(getRefs(id, 'products'), { refs: [] } as Awaited<ReturnType<typeof getRefs>>),
        raceOrFallback(getVoiceoverUrl(id), null),
        raceOrFallback(getVoiceoverGenerations(id), { generations: [] } as Awaited<ReturnType<typeof getVoiceoverGenerations>>),
        raceOrFallback(getCast(id), null),
      ]);
    // One-shot migration: if no characters.json exists yet but a legacy
    // protagonist.json does, seed the new file from it. Idempotent because
    // we check refs.length === 0 before seeding.
    let chars = characters;
    if (chars.refs.length === 0 && protagonist?.url) {
      chars = {
        refs: [
          { url: protagonist.url, added_at: protagonist.updated_at || new Date().toISOString() },
        ],
      };
      await putRefs(id, 'characters', chars);
    }
    // Force-bust voiceover_url by appending meta.updated_at. Supabase public
    // URLs stay the same path after every overwrite, so without this the
    // browser will happily replay bytes it cached from the previous voice
    // — even Supabase's CDN can briefly hold the old object. Tying the
    // query string to meta.updated_at guarantees the URL changes every
    // time a TTS/swap run touched meta.
    const versioned_voiceover_url = voiceover_url && meta.updated_at
      ? `${voiceover_url}${voiceover_url.includes('?') ? '&' : '?'}rev=${encodeURIComponent(meta.updated_at)}`
      : voiceover_url;

    return Response.json(
      {
        meta,
        script,
        timeline,
        prompts,
        approvals,
        protagonist,
        characters: chars,
        products,
        voiceover_url: versioned_voiceover_url,
        voiceover_generations: voiceover_generations.generations,
        cast,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

// PATCH /api/projects/{id}  { aspect? }
//   Partial update of project meta. Currently only the aspect ratio is
//   editable here; future platform-target / voice-default fields can slot
//   in alongside. Validates aspect against the ASPECT_PRESETS catalog.
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'not_found' }, { status: 404 });

    let dirty = false;
    if (typeof body?.aspect === 'string') {
      const valid = ASPECT_PRESETS.some((p) => p.id === body.aspect);
      if (!valid) {
        return Response.json(
          { error: `aspect must be one of ${ASPECT_PRESETS.map((p) => p.id).join(', ')}` },
          { status: 400 },
        );
      }
      meta.aspect = body.aspect;
      dirty = true;
    }
    if (typeof body?.title === 'string') {
      const trimmed = body.title.trim();
      if (trimmed.length < 1) {
        return Response.json({ error: 'title must be at least 1 character' }, { status: 400 });
      }
      if (trimmed.length > 120) {
        return Response.json({ error: 'title must be 120 characters or fewer' }, { status: 400 });
      }
      meta.title = trimmed;
      dirty = true;
    }
    if (body?.archived === true) {
      // Stamp once — idempotent re-archive doesn't bump the timestamp so
      // the original archive date stays sortable.
      if (!meta.archived_at) {
        meta.archived_at = new Date().toISOString();
        dirty = true;
      }
    } else if (body?.archived === false) {
      if (meta.archived_at) {
        meta.archived_at = undefined;
        dirty = true;
      }
    }

    // Idempotent archive toggles (body.archived set but no state change)
    // should succeed silently — return the unchanged meta. Only error if
    // the body had no recognised keys at all.
    const hadArchiveKey = body && 'archived' in body;
    const hadAnyKey =
      dirty ||
      hadArchiveKey ||
      typeof body?.aspect === 'string' ||
      typeof body?.title === 'string';
    if (!hadAnyKey) {
      return Response.json({ error: 'no supported fields in body' }, { status: 400 });
    }
    if (dirty) {
      meta.updated_at = new Date().toISOString();
      await putMeta(meta);
    }
    return Response.json({ ok: true, meta });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    // Before blowing away the storage, peek at the project's series_id so
    // we can splice it out of that series' episode_ids index. Otherwise
    // SeriesBar would render a zombie entry pointing at a deleted project.
    const meta = await getMeta(id);
    const removed = await deleteProject(id);
    if (meta?.series_id) {
      try {
        const series = await getSeriesMeta(meta.series_id);
        if (series) {
          const next = series.episode_ids.filter((x) => x !== id);
          if (next.length !== series.episode_ids.length) {
            series.episode_ids = next;
            await putSeriesMeta(series);
          }
        }
      } catch {
        /* non-fatal — index cleanup, not the primary delete */
      }
    }
    return Response.json({ ok: true, removed });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
