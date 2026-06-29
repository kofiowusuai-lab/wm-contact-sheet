// Per-project approvals — same shape as the legacy /api/approvals.
// GET  -> {approved: string[]}
// POST {seg_id, approved}            -> toggle one
// POST {bulk: true, approved: [...]} -> replace the set

import { getApprovals, putApprovals } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const s = await getApprovals(id);
    return Response.json(s, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const current = await getApprovals(id);
    const set = new Set(current.approved);
    if (body.bulk && Array.isArray(body.approved)) {
      set.clear();
      for (const s of body.approved) if (typeof s === 'string') set.add(s);
    } else if (typeof body.seg_id === 'string') {
      const want = body.approved !== false;
      if (want) set.add(body.seg_id);
      else set.delete(body.seg_id);
    } else {
      return Response.json({ error: 'seg_id or bulk+approved[] required' }, { status: 400 });
    }
    const next = { approved: Array.from(set).sort(), updated_at: new Date().toISOString() };
    await putApprovals(id, next);
    if (typeof body.seg_id === 'string') {
      await appendChange(id, {
        type: body.approved !== false ? 'approve' : 'unapprove',
        seg_id: body.seg_id,
      });
    }
    return Response.json({ ok: true, count: next.approved.length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
