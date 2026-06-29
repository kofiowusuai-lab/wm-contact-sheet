// POST /api/projects/{id}/locations/{loc_id}/variant
//   body: { aspect: string, image_data_url: string }
//   Attach an aspect-variant to a project-owned Location. Library-sourced
//   locations are rejected — fork first. Client does letterbox + Grok
//   edit + composite-back clamp (see `app/lib/reframeImage.ts`) and hands
//   us the final PNG/JPEG data URL. We persist to Supabase and patch the
//   location's `variants` map.

import {
  getLocations,
  putLocations,
  putVariantImage,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string; loc_id: string }> };

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, loc_id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const aspect = String(body?.aspect || '').trim();
    const dataUrl = String(body?.image_data_url || '');
    if (!aspect) return Response.json({ error: 'aspect required' }, { status: 400 });
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return Response.json({ error: 'invalid image_data_url' }, { status: 400 });

    const doc = await getLocations(id);
    const idx = doc.locations.findIndex((l) => l.id === loc_id);
    if (idx < 0) {
      return Response.json(
        { error: 'location not found (library-sourced locations must be forked first)' },
        { status: 404 },
      );
    }
    const loc = doc.locations[idx];
    if (loc.from_library) {
      return Response.json(
        { error: 'library-sourced locations are shared — fork first to create a variant' },
        { status: 400 },
      );
    }

    const slot = `locations/${loc_id}`;
    const variantUrl = await putVariantImage(id, slot, aspect, parsed.buf, parsed.mime);
    const nextLoc = {
      ...loc,
      variants: { ...(loc.variants || {}), [aspect]: variantUrl },
      updated_at: new Date().toISOString(),
    };
    doc.locations[idx] = nextLoc;
    await putLocations(id, doc);
    return Response.json({ location: nextLoc, variant_url: variantUrl });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
