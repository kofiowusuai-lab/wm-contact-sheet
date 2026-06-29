// Bulk frame actions for a project.
//
// POST /api/projects/{id}/frames
//   { action: "clear_all" }              -> remove every frame blob + strip
//                                           frame_url from every timeline entry
//   { action: "clear", seg_ids: [...] }  -> same but only for the given IDs
//
// One read + one write of timeline.json regardless of how many segments are
// cleared, so Vercel Blob's eventual consistency can't cause partial patches.

import { getTimeline, putTimeline, projectPath, removePaths, type Segment } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const action = String(body?.action || '');
    if (action !== 'clear_all' && action !== 'clear') {
      return Response.json({ error: 'action must be clear_all or clear' }, { status: 400 });
    }
    const timeline = (await getTimeline(id)) ?? [];
    let targetIds: Set<string>;
    if (action === 'clear_all') {
      targetIds = new Set(timeline.filter((s) => s.frame_url).map((s) => s.id));
    } else {
      const seg_ids = Array.isArray(body?.seg_ids) ? body.seg_ids.filter((x: any) => typeof x === 'string') : [];
      if (seg_ids.length === 0) {
        return Response.json({ error: 'seg_ids required for clear action' }, { status: 400 });
      }
      targetIds = new Set(seg_ids);
    }
    if (targetIds.size === 0) return Response.json({ ok: true, cleared: 0 });

    // Single-shot remove across all target paths
    const paths = Array.from(targetIds)
      .filter((sid) => /^[A-Za-z0-9_\-]+$/.test(sid))
      .map((sid) => projectPath(id, `frames/${sid}.jpg`));
    const removed = await removePaths(paths);

    // Single timeline rewrite — strip frame_url from every targeted segment at once
    const updated: Segment[] = timeline.map((s) => {
      if (targetIds.has(s.id) && s.frame_url) {
        const { frame_url, ...rest } = s;
        return rest as Segment;
      }
      return s;
    });
    await putTimeline(id, updated);

    // Return the updated timeline so the client can patch state directly.
    // Supabase's CDN has read-after-write lag that sometimes returns the
    // pre-clear timeline on a follow-up GET, leaving the UI showing frames
    // the server just deleted.
    return Response.json({
      ok: true,
      cleared: targetIds.size,
      blob_deletions_ok: removed.length,
      timeline: updated,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
