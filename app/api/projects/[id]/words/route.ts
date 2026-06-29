// GET /api/projects/{id}/words -> WordsDoc-shaped payload
// Returns the project's Whisper word-level timestamps plus the raw
// full_text and segment breakdown. Powers the Split picker AND the
// rewrite-in-my-voice orchestrator step, which reads full_text to
// decide whether there's anything to pass to Gemini for rewriting.

import { getWords } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const doc = await getWords(id);
    if (!doc) {
      return Response.json(
        { words: [], full_text: '', segments: [], total_words: 0, total_duration: 0 },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      {
        words: doc.words ?? [],
        full_text: doc.full_text ?? '',
        segments: doc.segments ?? [],
        total_words: doc.total_words,
        total_duration: doc.total_duration,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
