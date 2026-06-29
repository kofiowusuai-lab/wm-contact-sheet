// POST /api/projects/{id}/timeline/split  { seg_id, split_at_time }
//
// Splits one existing segment into two at an audio timestamp. The split time
// must fall strictly inside the segment's [start, end) range.
//   - The original segment keeps its id, frame_url, prompt, ken_burns, etc.
//     Its narration shrinks to the words BEFORE the split and its end time
//     becomes split_at_time.
//   - A NEW segment is inserted right after, carrying the words FROM the
//     split onward. It gets a fresh id, no frame, no prompt — ready
//     for the user to generate.
//
// No audio splicing: voiceover.mp3 stays byte-identical — only timeline.json
// changes. Narration text is re-derived from Whisper's words.json so the two
// halves reflect what was actually spoken, not the original script paragraphs.

import { getTimeline, putTimeline, getWords, type Segment } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

// Find the smallest unused VO_NNN id based on the existing timeline.
function nextSegId(existing: Segment[]): string {
  let max = -1;
  for (const s of existing) {
    const m = /^VO_(\d+)$/i.exec(s.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `VO_${String(max + 1).padStart(3, '0')}`;
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const segId = String(body?.seg_id || '').trim();
    const splitAtTime = Number(body?.split_at_time);
    if (!segId) return Response.json({ error: 'seg_id required' }, { status: 400 });
    if (!Number.isFinite(splitAtTime)) {
      return Response.json({ error: 'split_at_time (seconds) required' }, { status: 400 });
    }

    const [timeline, wordsDoc] = await Promise.all([getTimeline(id), getWords(id)]);
    if (!timeline) return Response.json({ error: 'timeline not found' }, { status: 404 });

    const segIdx = timeline.findIndex((s) => s.id === segId);
    if (segIdx < 0) return Response.json({ error: `segment ${segId} not found` }, { status: 404 });
    const seg = timeline[segIdx];

    const MIN_HALF = 0.1; // seconds — both halves must be at least this long
    if (splitAtTime <= seg.start + MIN_HALF || splitAtTime >= seg.end - MIN_HALF) {
      return Response.json(
        {
          error: `split_at_time ${splitAtTime.toFixed(2)}s is outside segment [${seg.start.toFixed(2)}, ${seg.end.toFixed(2)}]; each half must be at least ${MIN_HALF}s`,
        },
        { status: 400 },
      );
    }

    // Rebuild the two halves' narration from Whisper's word timings when
    // available — this stays faithful to what was actually spoken in each
    // half. If words.json is missing (e.g. an older project), fall back to
    // keeping the original narration on the first half and leaving the
    // second half's narration empty for the user to fill in.
    let firstNarration = seg.narration;
    let secondNarration = '';
    if (wordsDoc?.words?.length) {
      const firstWords: string[] = [];
      const secondWords: string[] = [];
      for (const w of wordsDoc.words) {
        if (w.start >= seg.start && w.start < seg.end) {
          if (w.start < splitAtTime) firstWords.push(w.word);
          else secondWords.push(w.word);
        }
      }
      // Only swap in the Whisper-derived narration if we actually captured
      // words on both sides; otherwise keep the original text untouched so
      // the user doesn't lose their script.
      if (firstWords.length > 0 && secondWords.length > 0) {
        firstNarration = firstWords.join(' ').trim();
        secondNarration = secondWords.join(' ').trim();
      }
    }

    const newId = nextSegId(timeline);
    const firstSeg: Segment = {
      ...seg,
      narration: firstNarration,
      end: splitAtTime,
      duration: Math.max(0.05, splitAtTime - seg.start),
    };
    const secondSeg: Segment = {
      id: newId,
      start: splitAtTime,
      end: seg.end,
      duration: Math.max(0.05, seg.end - splitAtTime),
      narration: secondNarration,
      kind: seg.kind,
    };

    const updated = [
      ...timeline.slice(0, segIdx),
      firstSeg,
      secondSeg,
      ...timeline.slice(segIdx + 1),
    ];
    await putTimeline(id, updated);

    await appendChange(id, {
      type: 'prompt.update',
      seg_id: segId,
      before: { narration: seg.narration, end: seg.end },
      after: {
        first: { id: firstSeg.id, end: firstSeg.end, narration: firstSeg.narration },
        second: { id: secondSeg.id, start: secondSeg.start, narration: secondSeg.narration },
      },
      meta: { op: 'timeline.split', split_time: splitAtTime, new_seg_id: newId },
    });

    return Response.json({
      ok: true,
      first: firstSeg,
      second: secondSeg,
      split_time: splitAtTime,
      // Return the full updated timeline so the client can patch its state
      // directly — avoids a race with Supabase Storage's read-after-write
      // propagation delay (a follow-up GET can otherwise return the stale
      // pre-split copy for a few hundred ms).
      timeline: updated,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
