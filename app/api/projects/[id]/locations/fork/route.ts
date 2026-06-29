// POST /api/projects/{id}/locations/fork { location_id }
//   Copy a subscribed-library location into the project as its own owned copy
//   so the project can edit it without affecting the library. The project's
//   forked copy shadows the library's entry in the merged catalog.

import { getLocations, putLocations, getMergedLocations } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const locationId = String(body?.location_id || '').trim();
    if (!locationId) return Response.json({ error: 'location_id required' }, { status: 400 });

    const merged = await getMergedLocations(id);
    const source = merged.find((l) => l.id === locationId);
    if (!source) return Response.json({ error: `location ${locationId} not found` }, { status: 404 });
    if (!source.from_library) {
      return Response.json(
        { error: `location ${locationId} is already project-owned` },
        { status: 400 },
      );
    }

    const doc = await getLocations(id);
    if (doc.locations.some((l) => l.id === locationId)) {
      return Response.json({ error: 'project already has a fork' }, { status: 409 });
    }

    const now = new Date().toISOString();
    // Strip `from_library` on the fork so it shows up as project-owned.
    const { from_library: _removed, ...clean } = source;
    doc.locations.push({ ...clean, added_at: now, updated_at: now });
    await putLocations(id, doc);

    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.fork', location_id: locationId, from_library: _removed },
    });

    return Response.json({ ok: true, location: { ...clean, added_at: now, updated_at: now } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
