import { getTimeline, putTimeline, getMergedLocations, type Segment } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 15;

type Ctx = { params: Promise<{ id: string }> };

// Accept both the new "<motion>:<intensity>" format and the five legacy
// single-token values persisted by earlier versions of the picker. The new
// motion and intensity vocabularies are kept in sync with app/lib/kenBurns.ts
// and the ffmpeg filter matrix in scripts/render_from_supabase.py.
const LEGACY_KB = new Set(['zoom_in', 'push_in', 'pan_right', 'pan_left', 'zoom_out']);
const KB_MOTIONS = new Set([
  'zoom_in', 'zoom_out',
  'center_push', 'center_pull',
  'pan_lr', 'pan_rl', 'pan_tb', 'pan_bt',
  'diagonal_push', 'diagonal_pull',
  'parallax_drift', 'static',
]);
const KB_INTENSITIES = new Set(['low', 'medium', 'high']);

function isValidKenBurns(v: string): boolean {
  if (LEGACY_KB.has(v)) return true;
  const [m, i] = v.split(':').map((x) => x.trim());
  return KB_MOTIONS.has(m) && KB_INTENSITIES.has(i);
}

export async function GET(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const t = (await getTimeline(id)) ?? [];
    return Response.json({ timeline: t }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const segs = Array.isArray(body?.timeline) ? (body.timeline as Segment[]) : null;
    if (!segs) return Response.json({ error: 'timeline[] required' }, { status: 400 });
    await putTimeline(id, segs);
    return Response.json({ ok: true, count: segs.length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

// PATCH /api/projects/{id}/timeline { seg_id, ken_burns }
//   Narrow per-segment update for the Ken Burns picker. Writes the full
//   timeline back (whole-file overwrite, same pattern as frames PATCH).
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const segId = String(body?.seg_id || '').trim();
    if (!segId) return Response.json({ error: 'seg_id required' }, { status: 400 });

    // Accept ken_burns / location / is_video in a single PATCH body. Callers
    // may supply any combination. Each gets validated independently.
    const hasKenBurns = typeof body?.ken_burns === 'string';
    const hasLocation = typeof body?.location === 'string';
    const hasIsVideo = typeof body?.is_video === 'boolean';
    if (!hasKenBurns && !hasLocation && !hasIsVideo) {
      return Response.json({ error: 'ken_burns, location, or is_video field required' }, { status: 400 });
    }
    const ken = hasKenBurns ? String(body.ken_burns).trim().toLowerCase() : null;
    const location = hasLocation ? String(body.location).trim() : null;
    const isVideo = hasIsVideo ? Boolean(body.is_video) : null;

    if (ken !== null && !isValidKenBurns(ken)) {
      return Response.json(
        { error: 'ken_burns must be "<motion>:<intensity>" (motion ∈ center_push|center_pull|pan_lr|pan_rl|pan_tb|pan_bt|diagonal_push|diagonal_pull|parallax_drift|static, intensity ∈ low|medium|high) or a legacy single token' },
        { status: 400 },
      );
    }
    // Empty-string location clears the tag; any other value must exist in the
    // merged location catalog (project + subscribed library).
    if (location !== null && location !== '') {
      const merged = await getMergedLocations(id);
      if (!merged.some((l) => l.id === location)) {
        return Response.json(
          { error: `location ${location} not found in project catalog` },
          { status: 400 },
        );
      }
    }

    const timeline = (await getTimeline(id)) ?? [];
    const priorSeg = timeline.find((s) => s.id === segId);
    const priorKen = priorSeg?.ken_burns ?? null;
    const priorLoc = priorSeg?.location ?? null;
    const priorIsVideo = priorSeg?.is_video ?? false;
    let patched = false;
    const updated = timeline.map((s) => {
      if (s.id === segId) {
        patched = true;
        const next: Segment = { ...s };
        if (ken !== null) next.ken_burns = ken;
        if (location !== null) {
          if (location === '') delete (next as any).location;
          else next.location = location;
        }
        if (isVideo !== null) {
          if (isVideo) next.is_video = true;
          else delete (next as any).is_video;
        }
        return next;
      }
      return s;
    });
    if (!patched) return Response.json({ error: 'seg_id not found in timeline' }, { status: 404 });
    await putTimeline(id, updated);

    if (ken !== null) {
      await appendChange(id, {
        type: 'ken_burns.change',
        seg_id: segId,
        before: priorKen ? { ken_burns: priorKen } : undefined,
        after: { ken_burns: ken },
      });
    }
    if (location !== null) {
      await appendChange(id, {
        type: 'refs.update',
        seg_id: segId,
        before: priorLoc ? { location: priorLoc } : undefined,
        after: { location: location || null },
        meta: { op: 'segment.location' },
      });
    }
    if (isVideo !== null) {
      await appendChange(id, {
        type: 'refs.update',
        seg_id: segId,
        before: { is_video: priorIsVideo },
        after: { is_video: isVideo },
        meta: { op: 'segment.is_video' },
      });
    }
    return Response.json({
      ok: true,
      seg_id: segId,
      ...(ken !== null ? { ken_burns: ken } : {}),
      ...(location !== null ? { location } : {}),
      ...(isVideo !== null ? { is_video: isVideo } : {}),
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
