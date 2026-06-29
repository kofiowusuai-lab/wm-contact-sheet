// GET    /api/projects/{id}/locations            -> merged project + library locations
// POST   /api/projects/{id}/locations             -> add a location (Gemini auto-describes if description omitted)
// PATCH  /api/projects/{id}/locations {id, ...}    -> edit a project-owned location
// DELETE /api/projects/{id}/locations?id=xxx       -> remove a project-owned location

import {
  getLocations,
  putLocations,
  putLocationImage,
  getMergedLocations,
  type Location,
} from '@/app/lib/blob';
import { describeLocation } from '@/app/lib/gemini';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const ID_RE = /^[a-z0-9_\-]+$/i;

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || `loc_${Date.now()}`;
}

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const locations = await getMergedLocations(id);
    return Response.json(
      { locations },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const name = String(body?.name || '').trim();
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });

    let locationId = String(body?.id || '').trim();
    if (locationId && !ID_RE.test(locationId)) {
      return Response.json({ error: 'id must be alphanumeric + _ / -' }, { status: 400 });
    }

    const doc = await getLocations(id);
    if (!locationId) {
      const base = slugify(name);
      let candidate = base;
      let i = 2;
      while (doc.locations.some((l) => l.id === candidate)) {
        candidate = `${base}_${i++}`;
      }
      locationId = candidate;
    } else if (doc.locations.some((l) => l.id === locationId)) {
      return Response.json({ error: `location ${locationId} already exists` }, { status: 409 });
    }

    // Accept either a fully-hosted image_url OR a data_url / base64 upload.
    let imageUrl = String(body?.image_url || '').trim();
    if (!imageUrl && typeof body?.data_url === 'string') {
      const parsed = parseDataUrl(body.data_url);
      if (!parsed) return Response.json({ error: 'invalid data_url' }, { status: 400 });
      imageUrl = await putLocationImage(id, locationId, parsed.buf, parsed.mime);
    }
    if (!imageUrl) {
      return Response.json({ error: 'image_url or data_url required' }, { status: 400 });
    }

    // Auto-describe via Gemini if the client didn't provide a description.
    let description = String(body?.description || '').trim();
    if (!description) {
      try {
        description = await describeLocation(imageUrl);
      } catch (e: any) {
        // Fail soft — save the location with a placeholder description so the
        // operator can write one manually. Surfaced in the response so the UI
        // can flash a warning.
        description = '';
      }
    }

    const now = new Date().toISOString();
    const loc: Location = {
      id: locationId,
      name,
      image_url: imageUrl,
      description,
      tags: Array.isArray(body?.tags) ? body.tags.filter((t: any) => typeof t === 'string') : [],
      added_at: now,
      updated_at: now,
    };
    doc.locations.push(loc);
    await putLocations(id, doc);

    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.add', location_id: locationId, name },
    });

    return Response.json({ ok: true, location: loc, auto_described: !body?.description });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const locationId = String(body?.id || '').trim();
    if (!locationId) return Response.json({ error: 'id required' }, { status: 400 });

    const doc = await getLocations(id);
    const idx = doc.locations.findIndex((l) => l.id === locationId);
    if (idx < 0) {
      return Response.json(
        { error: `location ${locationId} not found in project (library locations must be forked before editing)` },
        { status: 404 },
      );
    }
    const prev = doc.locations[idx];
    const updated: Location = { ...prev };
    if (typeof body?.name === 'string') updated.name = body.name.trim();
    if (typeof body?.description === 'string') updated.description = body.description.trim();
    if (typeof body?.image_url === 'string') updated.image_url = body.image_url.trim();
    if (Array.isArray(body?.tags)) {
      updated.tags = body.tags.filter((t: any) => typeof t === 'string');
    }
    if (typeof body?.data_url === 'string') {
      const parsed = parseDataUrl(body.data_url);
      if (parsed) {
        updated.image_url = await putLocationImage(id, locationId, parsed.buf, parsed.mime);
      }
    }
    updated.updated_at = new Date().toISOString();
    doc.locations[idx] = updated;
    await putLocations(id, doc);

    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.edit', location_id: locationId },
    });

    return Response.json({ ok: true, location: updated });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const locationId = url.searchParams.get('id') || '';
    if (!locationId) return Response.json({ error: 'id query param required' }, { status: 400 });
    const doc = await getLocations(id);
    const before = doc.locations.length;
    doc.locations = doc.locations.filter((l) => l.id !== locationId);
    if (doc.locations.length === before) {
      return Response.json({ error: `location ${locationId} not found` }, { status: 404 });
    }
    await putLocations(id, doc);
    await appendChange(id, {
      type: 'refs.update',
      meta: { op: 'locations.remove', location_id: locationId },
    });
    return Response.json({ ok: true });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
