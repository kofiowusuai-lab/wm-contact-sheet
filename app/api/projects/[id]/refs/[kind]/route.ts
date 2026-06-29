// GET    /api/projects/{id}/refs/{kind}             -> { refs: Ref[] }
// POST   /api/projects/{id}/refs/{kind}  { url, label? } -> append
// DELETE /api/projects/{id}/refs/{kind}?url=...       -> remove one
//
// kind must be "characters" or "products".

import { getRefs, putRefs, type Ref, type RefKind } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string; kind: string }> };

function parseKind(raw: string): RefKind | null {
  if (raw === 'characters' || raw === 'products') return raw;
  return null;
}

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id, kind } = await ctx.params;
    const k = parseKind(kind);
    if (!k) return Response.json({ error: 'bad kind' }, { status: 400 });
    const list = await getRefs(id, k);
    return Response.json(list, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, kind } = await ctx.params;
    const k = parseKind(kind);
    if (!k) return Response.json({ error: 'bad kind' }, { status: 400 });
    const body = await req.json().catch(() => null);
    const url = body?.url ? String(body.url) : '';
    if (!url.startsWith('http')) {
      return Response.json({ error: 'url required (http/https)' }, { status: 400 });
    }
    const list = await getRefs(id, k);
    // Dedupe by URL
    if (list.refs.find((r) => r.url === url)) {
      return Response.json({ refs: list.refs, duplicate: true });
    }
    const entry: Ref = {
      url,
      added_at: new Date().toISOString(),
      label: body?.label ? String(body.label).slice(0, 80) : undefined,
    };
    const next = { refs: [...list.refs, entry] };
    await putRefs(id, k, next);
    return Response.json(next);
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, kind } = await ctx.params;
    const k = parseKind(kind);
    if (!k) return Response.json({ error: 'bad kind' }, { status: 400 });
    const body = await req.json().catch(() => null);
    const url = body?.url ? String(body.url) : '';
    if (!url) return Response.json({ error: 'url required' }, { status: 400 });
    const list = await getRefs(id, k);
    let patched = false;
    const nextRefs = list.refs.map((r) => {
      if (r.url !== url) return r;
      patched = true;
      // `character: null` / `""` clears the tag (back to all-frames ref).
      // `character: "sarah"` normalises to `SARAH`.
      let nextCharacter = r.character;
      if ('character' in (body || {})) {
        const raw = body.character;
        if (raw === null || raw === '' || raw === undefined) {
          nextCharacter = undefined;
        } else if (typeof raw === 'string') {
          const cleaned = raw.trim().toUpperCase().slice(0, 40);
          nextCharacter = cleaned || undefined;
        }
      }
      return {
        ...r,
        notes:
          typeof body?.notes === 'string'
            ? String(body.notes).slice(0, 2000)
            : r.notes,
        label:
          typeof body?.label === 'string'
            ? String(body.label).slice(0, 120)
            : r.label,
        character: nextCharacter,
      };
    });
    if (!patched) return Response.json({ error: 'ref not found' }, { status: 404 });
    await putRefs(id, k, { refs: nextRefs });
    return Response.json({ refs: nextRefs });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id, kind } = await ctx.params;
    const k = parseKind(kind);
    if (!k) return Response.json({ error: 'bad kind' }, { status: 400 });
    const target = new URL(req.url).searchParams.get('url');
    if (!target) return Response.json({ error: 'url query param required' }, { status: 400 });
    const list = await getRefs(id, k);
    const next = { refs: list.refs.filter((r) => r.url !== target) };
    if (next.refs.length === list.refs.length) {
      return Response.json({ refs: next.refs, removed: 0 });
    }
    await putRefs(id, k, next);
    return Response.json({ refs: next.refs, removed: 1 });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
