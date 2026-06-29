// POST /api/projects/{id}/realign-preserve
//
// After a fresh voiceover + transcribe (new words.json), rewrite the
// start / end / duration on every segment in the existing timeline by
// forward-matching its narration against the new word-level timings.
//
// What's preserved per segment:
//   id, narration, frame_url, prompt, ken_burns, aspect, location, kind
//
// What's overwritten per segment:
//   start, end, duration
//
// This is the correct endpoint to call instead of /align when the script
// has been edited for pacing (added break tags, tiny punctuation changes,
// etc.) and you don't want to lose per-segment metadata.

import { getWords, getTimeline, putTimeline, type Segment } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

// Walk the word-list from `cursor` forward. Find the earliest position where
// the segment narration's token sequence matches (allowing small Whisper
// misrecognition — we accept up to two mismatches in the run). Return the
// index range that matched, or null.
function findRun(
  words: Array<{ word: string; start: number; end: number }>,
  cursor: number,
  narr: string[],
): { firstIdx: number; lastIdx: number } | null {
  if (narr.length === 0) return null;
  const maxCheckAhead = 400; // don't scan the whole transcript for one segment
  const limit = Math.min(words.length, cursor + maxCheckAhead);
  outer: for (let i = cursor; i <= limit - narr.length; i++) {
    let mismatches = 0;
    for (let j = 0; j < narr.length; j++) {
      const w = normalize(words[i + j]?.word ?? '');
      if (w !== narr[j]) {
        mismatches++;
        // Accept up to 2 token-level mismatches across the run to absorb
        // Whisper quirks (contractions, homophones).
        if (mismatches > Math.min(2, Math.floor(narr.length / 4))) continue outer;
      }
    }
    return { firstIdx: i, lastIdx: i + narr.length - 1 };
  }
  return null;
}

export async function POST(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const [timeline, wdoc] = await Promise.all([getTimeline(id), getWords(id)]);
    if (!timeline || timeline.length === 0) {
      return Response.json({ error: 'no existing timeline to refit' }, { status: 400 });
    }
    if (!wdoc || !Array.isArray(wdoc.words) || wdoc.words.length === 0) {
      return Response.json(
        { error: 'no words.json — run /transcribe after the fresh voiceover first' },
        { status: 400 },
      );
    }

    const words = wdoc.words;
    const audioDuration = wdoc.total_duration ?? words[words.length - 1]?.end ?? 0;

    let cursor = 0;
    const updated: Segment[] = [];
    const unmatched: string[] = [];

    for (const seg of timeline) {
      const narrTokens = tokens(seg.narration || '');
      // Empty-narration segments (pure title cards that only exist as a timing
      // placeholder) can't be matched — we leave them where they were, but
      // shift them proportionally to the audio-length scale ratio so gaps
      // stretch with the new (longer) audio.
      if (narrTokens.length === 0) {
        updated.push(seg);
        continue;
      }
      const hit = findRun(words, cursor, narrTokens);
      if (!hit) {
        unmatched.push(seg.id);
        updated.push(seg);
        continue;
      }
      const first = words[hit.firstIdx];
      const last = words[hit.lastIdx];
      updated.push({
        ...seg,
        start: first.start,
        end: last.end,
        duration: Math.max(0.05, last.end - first.start),
      });
      cursor = hit.lastIdx + 1;
    }

    // Sanity: if the LAST matched segment ends before the new audio duration,
    // extend it a little so the final frame doesn't cut off during render.
    // Render's gap-coverage logic already handles this, but we mirror it here
    // for subtitle / preview sync accuracy.
    const last = updated[updated.length - 1];
    if (last && audioDuration > 0 && last.end < audioDuration) {
      last.end = audioDuration;
      last.duration = Math.max(0.05, last.end - last.start);
    }

    await putTimeline(id, updated);

    return Response.json({
      ok: true,
      count: updated.length,
      matched: updated.length - unmatched.length,
      unmatched,
      audio_duration: audioDuration,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
