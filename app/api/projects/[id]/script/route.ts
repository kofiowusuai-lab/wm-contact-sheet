import { getScript, putScript, getMeta, putMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const text = (await getScript(id)) ?? '';
    return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const meta = await getMeta(id);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });
    const text = await req.text();
    await putScript(id, text);
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);
    return Response.json({ ok: true, length: text.length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
