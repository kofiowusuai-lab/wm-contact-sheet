// GET  /api/locations/library                    → list all libraries
// POST /api/locations/library { project_id, name } → snapshot a project's
//   current locations into a new shared library. Returns {library_id}.

import { listLibraries, getLocations, putLibrary, type LocationLibrary } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 15;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || `lib_${Date.now()}`;
}

export async function GET() {
  try {
    const libs = await listLibraries();
    return Response.json({ libraries: libs }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const projectId = String(body?.project_id || '').trim();
    const name = String(body?.name || '').trim();
    if (!projectId) return Response.json({ error: 'project_id required' }, { status: 400 });
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });

    const doc = await getLocations(projectId);
    if (doc.locations.length === 0) {
      return Response.json({ error: 'project has no locations to snapshot' }, { status: 400 });
    }

    const base = slugify(name);
    const libraryId = `${base}_${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const lib: LocationLibrary = {
      id: libraryId,
      name,
      owner_project_id: projectId,
      locations: doc.locations.map((l) => ({ ...l })),
      created_at: now,
      updated_at: now,
    };
    await putLibrary(lib);
    return Response.json({ ok: true, library_id: libraryId, name });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
