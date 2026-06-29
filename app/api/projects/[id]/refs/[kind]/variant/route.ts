// POST /api/projects/{id}/refs/{kind}/variant
//   body: { url: string, aspect: string, image_data_url: string }
//   Attach an aspect-variant image to a Ref. The client does the heavy
//   lifting (letterbox + Grok edit + composite-back clamp — see
//   `app/lib/reframeImage.ts`) and hands us the final clamped PNG/JPEG
//   data URL. We upload to Supabase and patch the Ref's `variants` map.

import crypto from 'node:crypto';
import {
  getRefs,
  putRefs,
  putVariantImage,
  type Ref,
  type RefKind,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string; kind: string }> };

function parseKind(raw: string): RefKind | null {
  if (raw === 'characters' || raw === 'products') return raw;
  return null;
}

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, kind } = await ctx.params;
    const k = parseKind(kind);
    if (!k) return Response.json({ error: 'bad kind' }, { status: 400 });

    const body = await req.json().catch(() => null);
    const url = String(body?.url || '').trim();
    const aspect = String(body?.aspect || '').trim();
    const dataUrl = String(body?.image_data_url || '');
    if (!url) return Response.json({ error: 'url required' }, { status: 400 });
    if (!aspect) return Response.json({ error: 'aspect required' }, { status: 400 });
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return Response.json({ error: 'invalid image_data_url' }, { status: 400 });

    const list = await getRefs(id, k);
    const targetIdx = list.refs.findIndex((r) => r.url === url);
    if (targetIdx < 0) return Response.json({ error: 'ref not found' }, { status: 404 });

    // Deterministic slot id — a short SHA1 of the source URL keeps the
    // upload path stable across regens and avoids collisions when two
    // refs happen to share a filename.
    const slot = `refs/${k}/${crypto
      .createHash('sha1')
      .update(url)
      .digest('hex')
      .slice(0, 12)}`;
    const variantUrl = await putVariantImage(id, slot, aspect, parsed.buf, parsed.mime);

    const next: Ref = {
      ...list.refs[targetIdx],
      variants: {
        ...(list.refs[targetIdx].variants || {}),
        [aspect]: variantUrl,
      },
    };
    const nextRefs = [...list.refs];
    nextRefs[targetIdx] = next;
    await putRefs(id, k, { refs: nextRefs });
    return Response.json({ refs: nextRefs, variant_url: variantUrl });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
