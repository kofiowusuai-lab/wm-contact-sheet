// GET  /api/projects            -> ProjectMeta[]
// POST /api/projects {id,title} -> creates projects/{id}/meta.json

import { listProjects, getMeta, putMeta, type ProjectMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export async function GET() {
  try {
    const metas = await listProjects();
    return Response.json({ projects: metas }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = String(body?.title || '').trim();
    const rawId = String(body?.id || body?.project_id || '').trim() || title;
    if (!title) return Response.json({ error: 'title required' }, { status: 400 });
    const id = slug(rawId);
    if (!id) return Response.json({ error: 'id produced an empty slug' }, { status: 400 });
    const existing = await getMeta(id);
    if (existing) return Response.json({ error: `project '${id}' exists` }, { status: 409 });
    const now = new Date().toISOString();
    const meta: ProjectMeta = { id, title, created_at: now, updated_at: now };
    await putMeta(meta);
    return Response.json({ project: meta });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
