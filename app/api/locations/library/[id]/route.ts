// GET   /api/locations/library/{id}               → read a shared library
// PATCH /api/locations/library/{id} { name?, locations? } → update (owner only)

import { getLibrary, putLibrary } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const lib = await getLibrary(id);
    if (!lib) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ library: lib }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const lib = await getLibrary(id);
    if (!lib) return Response.json({ error: 'not_found' }, { status: 404 });

    // Owner gate is soft — single-user dev setup, so the project_id header
    // isn't enforced cryptographically. Still check it to avoid accidents.
    const claimedOwner = String(body?.project_id || '').trim();
    if (claimedOwner && claimedOwner !== lib.owner_project_id) {
      return Response.json(
        { error: `only owner project ${lib.owner_project_id} can edit this library` },
        { status: 403 },
      );
    }

    if (typeof body?.name === 'string') lib.name = body.name.trim();
    if (Array.isArray(body?.locations)) lib.locations = body.locations;
    lib.updated_at = new Date().toISOString();
    await putLibrary(lib);
    return Response.json({ ok: true, library: lib });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
