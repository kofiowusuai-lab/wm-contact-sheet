// POST /api/projects/{id}/snap-timeline
//   Re-derives timeline.json from prompts.json narration lines + words.json.
//   Produces exactly one segment per VO_### entry that has a narration — so
//   the segment count matches the user's hand-curated 1:1 prompt list.

import { getWords, getPrompts, getTimeline, putTimeline } from '@/app/lib/blob';
import { snapToPrompts } from '@/app/lib/snapToPrompts';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const [wdoc, prompts, existing] = await Promise.all([
      getWords(id),
      getPrompts(id),
      getTimeline(id),
    ]);
    if (!wdoc?.words?.length) {
      return Response.json(
        { error: 'no words.json — run the full pipeline first so whisper timestamps exist' },
        { status: 400 },
      );
    }
    const promptCount = Object.keys(prompts || {}).filter(
      (k) => /^VO_\d+$/.test(k) && (prompts[k]?.narration || '').trim(),
    ).length;
    if (promptCount === 0) {
      return Response.json(
        { error: 'no prompts with narration — paste the mass-prompt block first' },
        { status: 400 },
      );
    }

    const snapped = snapToPrompts(wdoc.words, prompts, existing ?? []);
    await putTimeline(id, snapped);

    const voCount = snapped.filter((s) => s.kind === 'vo').length;
    const ecCount = snapped.filter((s) => s.kind === 'end_card').length;
    return Response.json({
      ok: true,
      vo_count: voCount,
      ec_count: ecCount,
      total_count: snapped.length,
      expected_prompt_count: promptCount,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
