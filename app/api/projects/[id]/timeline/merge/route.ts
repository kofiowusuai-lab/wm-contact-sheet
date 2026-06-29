// POST /api/projects/{id}/timeline/merge  { seg_id }
//
// Merges the given segment with the NEXT segment in the timeline. Reverses
// any split without requiring a dedicated undo stack.
//   - Current segment keeps its id, frame_url, prompt, ken_burns.
//   - end/duration extend to cover the next segment's range.
//   - narration becomes "current + next" joined with a single space.
//   - The next segment is removed from the timeline. Its frame (if any)
//     is orphaned — caller should confirm before losing work.
//
// No audio splicing — voiceover.mp3 stays byte-identical.

import { getTimeline, putTimeline, type Segment } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const segId = String(body?.seg_id || '').trim();
    if (!segId) return Response.json({ error: 'seg_id required' }, { status: 400 });

    const timeline = await getTimeline(id);
    if (!timeline) return Response.json({ error: 'timeline not found' }, { status: 404 });

    const segIdx = timeline.findIndex((s) => s.id === segId);
    if (segIdx < 0) return Response.json({ error: `segment ${segId} not found` }, { status: 404 });
    if (segIdx >= timeline.length - 1) {
      return Response.json({ error: 'no segment after this one to merge with' }, { status: 400 });
    }

    const cur = timeline[segIdx];
    const nxt = timeline[segIdx + 1];

    const mergedNarration = [cur.narration, nxt.narration]
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ');

    const merged: Segment = {
      ...cur,
      end: nxt.end,
      duration: Math.max(0.05, nxt.end - cur.start),
      narration: mergedNarration,
    };

    const updated = [
      ...timeline.slice(0, segIdx),
      merged,
      ...timeline.slice(segIdx + 2),
    ];
    await putTimeline(id, updated);

    await appendChange(id, {
      type: 'prompt.update',
      seg_id: segId,
      before: {
        current: { id: cur.id, end: cur.end, narration: cur.narration },
        next: { id: nxt.id, start: nxt.start, end: nxt.end, narration: nxt.narration },
      },
      after: { id: merged.id, end: merged.end, narration: merged.narration },
      meta: { op: 'timeline.merge', dropped_seg_id: nxt.id, dropped_had_frame: Boolean(nxt.frame_url) },
    });

    return Response.json({ ok: true, merged, dropped: nxt.id, timeline: updated });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
