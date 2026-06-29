// GET  /api/series             -> SeriesMeta[] (runs idempotent migration)
// POST /api/series {title, description?} -> creates series/{id}.json
//
// The GET handler does double duty: list + migrate. Every legacy project
// without a series_id gets folded into a single-episode series on first
// read, so existing URLs + localStorage keys keep working with zero user
// action. The migration is idempotent (skips any project that already has
// series_id set) and cheap (one extra read per project on first call,
// effectively free thereafter).

import {
  listProjects,
  listSeries,
  getSeriesMeta,
  putSeriesMeta,
  putMeta,
  type SeriesMeta,
  type ProjectMeta,
} from '@/app/lib/blob';
import { slug } from '@/app/lib/slug';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

async function migrateOrphans(): Promise<void> {
  const projects = await listProjects();
  for (const p of projects) {
    if (p.series_id) continue;
    // Series ID = project ID. Guaranteed unique at the project layer, so
    // safe at the sibling series layer too.
    const seriesId = p.id;
    const existing = await getSeriesMeta(seriesId);
    if (!existing) {
      const now = new Date().toISOString();
      const series: SeriesMeta = {
        id: seriesId,
        title: p.title,
        episode_ids: [p.id],
        created_at: p.created_at || now,
        updated_at: now,
      };
      await putSeriesMeta(series);
    } else if (!existing.episode_ids.includes(p.id)) {
      existing.episode_ids.push(p.id);
      await putSeriesMeta(existing);
    }
    const patched: ProjectMeta = {
      ...p,
      series_id: seriesId,
      episode_number: 1,
      updated_at: new Date().toISOString(),
    };
    await putMeta(patched);
  }
}

export async function GET() {
  try {
    await migrateOrphans();
    const series = await listSeries();
    return Response.json(
      { series },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = String(body?.title || '').trim();
    const description = String(body?.description || '').trim() || undefined;
    const rawId = String(body?.id || '').trim() || title;
    if (!title) return Response.json({ error: 'title required' }, { status: 400 });
    const id = slug(rawId);
    if (!id) return Response.json({ error: 'id produced an empty slug' }, { status: 400 });
    const existing = await getSeriesMeta(id);
    if (existing) return Response.json({ error: `series '${id}' exists` }, { status: 409 });
    const now = new Date().toISOString();
    const series: SeriesMeta = {
      id,
      title,
      description,
      episode_ids: [],
      created_at: now,
      updated_at: now,
    };
    await putSeriesMeta(series);
    return Response.json({ series });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
