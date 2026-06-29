// POST   /api/projects/{id}/locations/subscribe { library_id }  → attach library
// DELETE /api/projects/{id}/locations/subscribe                  → detach library

import { getMeta, putMeta, getLibrary } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const libraryId = String(body?.library_id || '').trim();
    if (!libraryId) return Response.json({ error: 'library_id required' }, { status: 400 });

    const lib = await getLibrary(libraryId);
    if (!lib) return Response.json({ error: `library ${libraryId} not found` }, { status: 404 });

    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });
    meta.location_library_id = libraryId;
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);

    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.subscribe', library_id: libraryId },
    });
    return Response.json({ ok: true, library: { id: lib.id, name: lib.name } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });
    const prev = meta.location_library_id;
    delete meta.location_library_id;
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);
    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.unsubscribe', library_id: prev ?? null },
    });
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
