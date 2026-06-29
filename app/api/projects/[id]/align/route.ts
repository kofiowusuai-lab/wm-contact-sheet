// POST /api/projects/{id}/align
//   Reads words.json, segments into sentences, preserves existing EC_* entries,
//   writes timeline.json.

import { getWords, getTimeline, putTimeline } from '@/app/lib/blob';
import { segmentWords, numberSegments } from '@/app/lib/segment';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    // Dense (word-level, splits on . , ! ? ; : — –) is the new default —
    // Whisper's sentence-level segments[] let list-style phrases collapse
    // into 6-second static holds. Legacy callers can pass `?dense=0` or
    // `{dense: false}` to fall back to the sentence-level boundaries.
    const url = new URL(req.url);
    const qpDense = url.searchParams.get('dense');
    const body = await req.json().catch(() => null);
    const dense = qpDense !== null
      ? qpDense !== '0' && qpDense !== 'false'
      : body?.dense !== false;

    const wdoc = await getWords(id);
    if (!wdoc) return Response.json({ error: 'no words.json; run /transcribe first' }, { status: 400 });
    const existing = (await getTimeline(id)) ?? [];
    const segs = dense
      ? segmentWords(wdoc.words || [])
      : (wdoc.segments?.length
        ? wdoc.segments.map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() }))
        : segmentWords(wdoc.words || []));
    const numbered = numberSegments(segs, existing);
    await putTimeline(id, numbered);
    return Response.json({
      ok: true,
      dense,
      count: numbered.length,
      vo_count: numbered.filter((s) => s.kind === 'vo').length,
      ec_count: numbered.filter((s) => s.kind === 'end_card').length,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
