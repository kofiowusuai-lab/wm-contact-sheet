// POST /api/projects/{id}/frames/batch-patch
//   Body: { updates: [{ seg_id, frame_url, aspect? }] }
//   Does ONE timeline.json read + applies every update + ONE write. Solves
//   the bulk-generate race where N parallel single-frame PUTs each read
//   timeline.json at the same time and clobber each other's writes when
//   they stamp their own frame_url back.
//
// The client uploads each frame's image independently (unique keys in
// storage don't race), then batches the timeline metadata updates through
// this endpoint every few frames.

import { getTimeline, putTimeline, type Segment } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

type Update = {
  seg_id: string;
  frame_url: string;
  aspect?: string;
};

const VALID_ASPECTS = new Set(['16:9', '9:16', '1:1', '4:5']);

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const raw: unknown = body?.updates;
    if (!Array.isArray(raw)) {
      return Response.json({ error: 'updates array required' }, { status: 400 });
    }
    const updates: Update[] = [];
    for (const u of raw) {
      if (!u || typeof u !== 'object') continue;
      const seg_id = String((u as any).seg_id || '').trim();
      const frame_url = String((u as any).frame_url || '').trim();
      const aspectRaw = (u as any).aspect;
      const aspect = typeof aspectRaw === 'string' && VALID_ASPECTS.has(aspectRaw) ? aspectRaw : undefined;
      if (!seg_id || !/^[A-Za-z0-9_\-]+$/.test(seg_id)) continue;
      if (!frame_url) continue;
      updates.push({ seg_id, frame_url, ...(aspect ? { aspect } : {}) });
    }
    if (updates.length === 0) {
      return Response.json({ ok: true, patched: 0, reason: 'nothing to update' });
    }

    // Single read.
    const timeline = (await getTimeline(id)) ?? [];
    const byId = new Map(updates.map((u) => [u.seg_id, u]));
    const priorUrls = new Map<string, string | null>();

    let patched = 0;
    const updated: Segment[] = timeline.map((s) => {
      const u = byId.get(s.id);
      if (!u) return s;
      priorUrls.set(s.id, s.frame_url ?? null);
      patched++;
      return {
        ...s,
        frame_url: u.frame_url,
        ...(u.aspect ? { aspect: u.aspect } : {}),
      };
    });

    // Single write.
    if (patched > 0) await putTimeline(id, updated);

    // Append one changelog event per update so the per-segment history is
    // preserved. Non-fatal if any individual one fails.
    for (const u of updates) {
      if (!byId.get(u.seg_id)) continue;
      try {
        await appendChange(id, {
          type: 'frame.generate',
          seg_id: u.seg_id,
          before: priorUrls.get(u.seg_id)
            ? { frame_url: priorUrls.get(u.seg_id) as string }
            : undefined,
          after: { frame_url: u.frame_url },
          meta: { batch: true },
        });
      } catch {
        /* non-fatal */
      }
    }

    return Response.json({ ok: true, patched, timeline: updated });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
