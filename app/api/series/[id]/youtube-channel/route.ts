// PUT /api/series/{id}/youtube-channel  { channel: string | null }
//   Pin / clear the YouTube channel slug for a series. Every episode in the
//   series inherits this — the upload dialog reads series.youtube_channel
//   and auto-routes uploads to that channel.

import { getSeriesMeta, putSeriesMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const raw = body?.channel;
    // Accept a slug string OR null/empty to clear.
    const slug =
      raw === null || raw === '' || raw === undefined
        ? undefined
        : String(raw).trim().slice(0, 60);
    if (slug && !/^[a-z0-9_-]+$/i.test(slug)) {
      return Response.json(
        { error: 'channel must match [a-z0-9_-] (slug from channels.json)' },
        { status: 400 },
      );
    }
    const series = await getSeriesMeta(id);
    if (!series) return Response.json({ error: 'series not found' }, { status: 404 });
    series.youtube_channel = slug;
    await putSeriesMeta(series);
    return Response.json({ ok: true, series });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
