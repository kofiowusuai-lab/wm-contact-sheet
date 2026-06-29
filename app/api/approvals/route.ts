// Global approvals store (legacy path) + per-project via project_id param.
//
//   GET  /api/approvals                             -> { approved: string[] }
//   POST /api/approvals { seg_id, approved: bool }  -> toggle a single seg
//   POST /api/approvals { bulk: true, approved: [] } -> replace the set
//
// Accept ?project_id=... / body.project_id for scoped approvals. When absent,
// falls back to the root-level approvals.json for back-compat with the
// pre-multi-project contact sheet.

import { readJson, writeJson } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

const LEGACY = 'approvals.json';

function pathFor(projectId?: string | null): string {
  const id = (projectId || '').trim();
  return id ? `projects/${id}/approvals.json` : LEGACY;
}

type State = { approved: string[]; updated_at?: string };

async function readState(projectId?: string | null): Promise<State> {
  const j = await readJson<State>(pathFor(projectId));
  return { approved: Array.isArray(j?.approved) ? j.approved : [] };
}

async function writeState(state: State, projectId?: string | null) {
  await writeJson(pathFor(projectId), {
    approved: state.approved.sort(),
    updated_at: new Date().toISOString(),
  });
}

export async function GET(req: Request) {
  try {
    const pid = new URL(req.url).searchParams.get('project_id');
    const s = await readState(pid);
    return Response.json(s, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const pid = typeof body?.project_id === 'string' ? body.project_id : null;
    const current = await readState(pid);
    const set = new Set(current.approved);
    if (body.bulk && Array.isArray(body.approved)) {
      set.clear();
      for (const id of body.approved) if (typeof id === 'string') set.add(id);
    } else if (typeof body.seg_id === 'string') {
      const want = body.approved !== false;
      if (want) set.add(body.seg_id);
      else set.delete(body.seg_id);
    } else {
      return Response.json({ error: 'seg_id or bulk+approved[] required' }, { status: 400 });
    }
    const next: State = { approved: Array.from(set).sort() };
    await writeState(next, pid);
    return Response.json({ ok: true, count: next.approved.length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
