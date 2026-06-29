// POST /api/projects/{id}/segments/batch-meta
//   Body: { updates: [{ seg_id, ref_seg_id?: string|null, prompt_archived?: string|null }] }
//   Single read, single write — patches segment metadata WITHOUT touching
//   frame_url. Sibling of frames/batch-patch (which is frame_url-required
//   and purpose-built for parallel-runner regen flushes).
//
// Used by the row chain-link toggle and the bulk "Lock run to anchor"
// action. `null` clears a field; missing means leave unchanged.

import { getPrompts, getTimeline, putPrompts, putTimeline, type Segment } from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

type Update = {
  seg_id: string;
  ref_seg_id?: string | null;
  prompt_archived?: string | null;
};

const SEG_ID_RE = /^[A-Za-z0-9_\-]+$/;

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const raw: unknown = body?.updates;
    if (!Array.isArray(raw)) {
      return Response.json({ error: 'updates array required' }, { status: 400 });
    }
    const updates: Update[] = [];
    for (const u of raw) {
      if (!u || typeof u !== 'object') continue;
      const seg_id = String((u as any).seg_id || '').trim();
      if (!seg_id || !SEG_ID_RE.test(seg_id)) continue;
      const out: Update = { seg_id };
      if ('ref_seg_id' in (u as any)) {
        const v = (u as any).ref_seg_id;
        if (v === null) out.ref_seg_id = null;
        else if (typeof v === 'string') {
          const trimmed = v.trim();
          if (trimmed && !SEG_ID_RE.test(trimmed)) continue;
          out.ref_seg_id = trimmed || null;
        }
      }
      if ('prompt_archived' in (u as any)) {
        const v = (u as any).prompt_archived;
        if (v === null) out.prompt_archived = null;
        else if (typeof v === 'string') out.prompt_archived = v;
      }
      // Skip rows that didn't actually carry a recognised mutation.
      if (out.ref_seg_id === undefined && out.prompt_archived === undefined) continue;
      updates.push(out);
    }
    if (updates.length === 0) {
      return Response.json({ ok: true, patched: 0, reason: 'nothing to update' });
    }

    const byId = new Map(updates.map((u) => [u.seg_id, u]));
    const knownSegmentIds = new Set<string>();

    // Single timeline read.
    const timeline = (await getTimeline(id)) ?? [];
    for (const s of timeline) knownSegmentIds.add(s.id);

    // Validate ref_seg_id targets exist in this project (avoid bad anchors).
    for (const u of updates) {
      if (u.ref_seg_id && !knownSegmentIds.has(u.ref_seg_id)) {
        return Response.json(
          { error: `unknown ref_seg_id "${u.ref_seg_id}" for segment ${u.seg_id}` },
          { status: 400 },
        );
      }
      if (u.ref_seg_id === u.seg_id) {
        return Response.json(
          { error: `segment ${u.seg_id} cannot reference itself` },
          { status: 400 },
        );
      }
    }

    let timelineDirty = false;
    const priorRefs = new Map<string, string | null>();
    const updatedTimeline: Segment[] = timeline.map((s) => {
      const u = byId.get(s.id);
      if (!u || u.ref_seg_id === undefined) return s;
      priorRefs.set(s.id, s.ref_seg_id ?? null);
      const next: Segment = { ...s };
      if (u.ref_seg_id === null || u.ref_seg_id === '') {
        delete next.ref_seg_id;
      } else {
        next.ref_seg_id = u.ref_seg_id;
      }
      timelineDirty = true;
      return next;
    });
    if (timelineDirty) await putTimeline(id, updatedTimeline);

    // Prompts pass — only when at least one update touches prompt_archived.
    let promptsDirty = false;
    if (updates.some((u) => u.prompt_archived !== undefined)) {
      const prompts = await getPrompts(id);
      for (const u of updates) {
        if (u.prompt_archived === undefined) continue;
        const cur = prompts[u.seg_id] ?? { prompt: '' };
        if (u.prompt_archived === null) {
          delete (cur as any).prompt_archived;
        } else {
          cur.prompt_archived = u.prompt_archived;
        }
        prompts[u.seg_id] = cur;
        promptsDirty = true;
      }
      if (promptsDirty) await putPrompts(id, prompts);
    }

    // Changelog (one entry per ref_seg_id mutation).
    for (const u of updates) {
      if (u.ref_seg_id === undefined) continue;
      const prior = priorRefs.get(u.seg_id) ?? null;
      const next = u.ref_seg_id ?? null;
      if (prior === next) continue;
      try {
        await appendChange(id, {
          type: next ? 'segment.lock' : 'segment.unlock',
          seg_id: u.seg_id,
          before: prior ? { ref_seg_id: prior } : undefined,
          after: next ? { ref_seg_id: next } : undefined,
        });
      } catch {
        /* non-fatal */
      }
    }

    return Response.json({
      ok: true,
      patched: updates.length,
      timeline: timelineDirty ? updatedTimeline : undefined,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
