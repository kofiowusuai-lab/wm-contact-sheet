// PATCH /api/projects/{id}/upload-meta  { upload_meta partial }
//   Merge into meta.upload_meta — the client calls this after a successful
//   tunnel upload so title/desc/tags/last_video_url persist across refreshes.

import { getMeta, putMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'body required' }, { status: 400 });
    }
    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });

    const existing = meta.upload_meta || {};
    // Shallow merge — caller sends only the fields it wants updated.
    meta.upload_meta = { ...existing, ...body };
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);
    return Response.json({ ok: true, upload_meta: meta.upload_meta });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
