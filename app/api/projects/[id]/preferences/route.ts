// GET /api/projects/{id}/preferences
//   -> { summary, rules[], updated_at, events_analyzed } | null

import { readJson } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const prefs = await readJson(`projects/${id}/preferences.json`);
    if (!prefs) {
      return Response.json({ preferences: null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json(
      { preferences: prefs },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
