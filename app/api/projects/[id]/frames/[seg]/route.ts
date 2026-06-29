// PUT /api/projects/{id}/frames/{seg} {data_url | image_url}
//   Uploads a pasted/generated image to Supabase Storage as
//   projects/{id}/frames/{seg}.jpg, then patches timeline.json[seg].frame_url.
//
// DELETE /api/projects/{id}/frames/{seg}
//   Removes the image + strips frame_url from that timeline entry.

import {
  getTimeline,
  putTimeline,
  putFrameBuffer,
  removePath,
  framePath,
  frameVideoPath,
  publicUrl,
  projectPath,
} from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';
import { snapshotBeforeOverwrite } from '@/app/lib/snapshots';

/** Extract the file extension from a stored frame_url. Strips `?v=...` cache-bust
 *  suffix. Returns 'jpg' / 'mp4' / null. */
function extFromFrameUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const noQuery = url.split('?')[0];
  const m = /\.([a-z0-9]+)$/i.exec(noQuery);
  return m ? m[1].toLowerCase() : null;
}

export const runtime = 'nodejs';
export const maxDuration = 30;

// Hard cap for video frame uploads. Vercel's data-URL path tops out at ~4.5MB;
// the signed-URL path lifts that — but a single-segment .mp4 over ~50MB is
// almost certainly the wrong asset and would balloon project storage.
const MAX_FRAME_VIDEO_BYTES = 50 * 1024 * 1024;

type Ctx = { params: Promise<{ id: string; seg: string }> };

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { id, seg } = await ctx.params;
    if (!/^[A-Za-z0-9_\-]+$/.test(seg)) {
      return Response.json({ error: 'bad seg id' }, { status: 400 });
    }
    const body = await req.json().catch(() => null);
    if (!body?.data_url && !body?.image_url && !body?.video_url && !body?.uploaded) {
      return Response.json(
        { error: 'data_url, image_url, video_url, or uploaded required' },
        { status: 400 },
      );
    }

    let baseUrl: string;
    let ct = 'image/jpeg';
    let bytesLen = 0;
    let isVideoPayload = false;
    // Snapshot of the previous frame bytes — populated below on byte-overwriting
    // paths and stamped into the changelog so /preferences/refresh can read the
    // BEFORE image when running its Gemini vision diff.
    let frameSnapshotUrl: string | null = null;

    // Path A — client uploaded straight to Supabase via the signed-url
    // sibling route. We just stamp the timeline; bytes are already at the
    // canonical path. Mirrors upload-voiceover { uploaded: true } shape.
    if (body.uploaded) {
      const mime = String(body.mime || 'video/mp4');
      isVideoPayload = /^video\//i.test(mime);
      bytesLen = Number(body.bytes) || 0;
      if (isVideoPayload && bytesLen > MAX_FRAME_VIDEO_BYTES) {
        return Response.json(
          { error: `file too large (${bytesLen} bytes) — frame video cap is 50MB` },
          { status: 413 },
        );
      }
      const ext = isVideoPayload
        ? (String(body.ext || 'mp4').toLowerCase().replace(/^\./, '') || 'mp4')
        : 'jpg';
      const path = projectPath(id, `frames/${seg}.${ext}`);
      baseUrl = publicUrl(path, false);
      ct = mime;
    } else {
      let bytes: Buffer;
      if (body.data_url) {
        const parsed = parseDataUrl(String(body.data_url));
        if (!parsed) return Response.json({ error: 'invalid data_url' }, { status: 400 });
        bytes = parsed.buf;
        ct = parsed.mime;
      } else {
        const src = String(body.video_url || body.image_url);
        const r = await fetch(src);
        if (!r.ok) return Response.json({ error: `fetch ${r.status}` }, { status: 500 });
        bytes = Buffer.from(await r.arrayBuffer());
        // Prefer the server's declared content-type. Force video/mp4 when the
        // caller explicitly supplied a video_url so a CDN that returns
        // application/octet-stream still lands on the .mp4 branch in
        // putFrameBuffer.
        ct = r.headers.get('content-type') || (body.video_url ? 'video/mp4' : ct);
        if (body.video_url && !/^video\//i.test(ct)) ct = 'video/mp4';
      }
      isVideoPayload = /^video\//i.test(ct);
      bytesLen = bytes.length;
      // Snapshot the existing object BEFORE we overwrite it. Supabase upserts
      // are destructive, so the only way to keep a Gemini-readable copy of the
      // before-state is to copy it to a never-overwritten path now. Read the
      // ext from the prior frame_url in the timeline; fall back to jpg/mp4
      // by isVideoPayload guess (snapshotBeforeOverwrite list-checks before
      // copy, so a wrong guess just returns null).
      const priorTl = (await getTimeline(id)) ?? [];
      const priorUrlForSnapshot = priorTl.find((s) => s.id === seg)?.frame_url ?? null;
      const priorExt = extFromFrameUrl(priorUrlForSnapshot) || (isVideoPayload ? 'mp4' : 'jpg');
      const snap = await snapshotBeforeOverwrite(id, 'frames', seg, priorExt);
      if (snap) frameSnapshotUrl = snap.snapshot_url;

      baseUrl = await putFrameBuffer(id, seg, bytes, ct);
    }
    // Cache-bust the stored URL so <img> always sees the new bytes.
    const versioned = `${baseUrl}?v=${Date.now()}`;

    // Stamp aspect onto the segment if the caller supplied one. Validated
    // against the catalog in app/lib/aspectRatios.ts; anything else is
    // ignored so a malformed request can't corrupt timeline.json.
    const VALID_ASPECTS = new Set(['16:9', '9:16', '1:1', '4:5']);
    const aspectStamp = typeof body?.aspect === 'string' && VALID_ASPECTS.has(body.aspect)
      ? (body.aspect as string)
      : null;

    // Bulk-generate callers set skip_timeline_patch=true and will batch the
    // timeline.json write themselves via /frames/batch-patch, avoiding the
    // race where N parallel per-frame writers overwrite each other's updates.
    const skipTimeline = body?.skip_timeline_patch === true;
    let patched = false;
    let priorUrl: string | null = null;
    if (!skipTimeline) {
      const timeline = (await getTimeline(id)) ?? [];
      priorUrl = timeline.find((s) => s.id === seg)?.frame_url ?? null;
      const updated = timeline.map((s) => {
        if (s.id === seg) {
          patched = true;
          const next = { ...s, frame_url: versioned } as typeof s;
          if (aspectStamp) next.aspect = aspectStamp;
          // Video payload → mark the segment so Row renders a <video>
          // instead of an <img>. Image payload → clear any stale flag.
          if (isVideoPayload) next.is_video = true;
          else if (next.is_video) delete (next as { is_video?: boolean }).is_video;
          return next;
        }
        return s;
      });
      if (patched) await putTimeline(id, updated);
    }

    // Changelog: distinguish paste (data_url supplied) from generate (image_url).
    if (!skipTimeline) {
      const changeType = body.uploaded
        ? 'frame.upload'
        : body.data_url
        ? 'frame.paste'
        : 'frame.generate';
      // `before` carries both the (now overwritten) public URL and the
      // never-overwritten snapshot URL so /preferences/refresh can pull the
      // actual before-bytes for Gemini's vision diff.
      const beforePayload: Record<string, unknown> | undefined = priorUrl
        ? { frame_url: priorUrl, ...(frameSnapshotUrl ? { snapshot_url: frameSnapshotUrl } : {}) }
        : undefined;
      // `meta.op` lets the autoFixBorders client mark its uploads as crops
      // rather than generic pastes — Gemini conditions its diff prompt on this.
      const opTag = typeof body?.meta?.op === 'string' ? String(body.meta.op).slice(0, 40) : null;
      await appendChange(id, {
        type: changeType,
        seg_id: seg,
        before: beforePayload,
        after: { frame_url: versioned },
        meta: { bytes: bytesLen, content_type: ct, ...(opTag ? { op: opTag } : {}) },
      });
    }

    return Response.json({ ok: true, frame_url: versioned, patched, skipped_timeline: skipTimeline });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

// PATCH /api/projects/{id}/frames/{seg} { frame_url }
//   Lightweight: just rewrites timeline.json[seg].frame_url to an existing
//   URL (typically a previous Supabase-hosted version). Used by the client
//   undo/redo flow to rewind without re-downloading bytes through FAL or
//   re-uploading to Supabase.
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id, seg } = await ctx.params;
    if (!/^[A-Za-z0-9_\-]+$/.test(seg)) {
      return Response.json({ error: 'bad seg id' }, { status: 400 });
    }
    const body = await req.json().catch(() => null);
    const frameUrl = String(body?.frame_url || '').trim();
    if (!frameUrl) {
      return Response.json({ error: 'frame_url required' }, { status: 400 });
    }
    const timeline = (await getTimeline(id)) ?? [];
    const priorUrl = timeline.find((s) => s.id === seg)?.frame_url ?? null;
    let patched = false;
    const updated = timeline.map((s) => {
      if (s.id === seg) {
        patched = true;
        return { ...s, frame_url: frameUrl };
      }
      return s;
    });
    if (patched) await putTimeline(id, updated);
    // Classify direction from the body or default to undo. The client sends
    // direction in meta when it knows; otherwise we just log as undo.
    const direction = String((body as any)?.direction || 'undo') === 'redo' ? 'redo' : 'undo';
    await appendChange(id, {
      type: direction === 'redo' ? 'frame.redo' : 'frame.undo',
      seg_id: seg,
      before: priorUrl ? { frame_url: priorUrl } : undefined,
      after: { frame_url: frameUrl },
    });
    return Response.json({ ok: true, patched, frame_url: frameUrl });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE(_: Request, ctx: Ctx) {
  try {
    const { id, seg } = await ctx.params;
    if (!/^[A-Za-z0-9_\-]+$/.test(seg)) {
      return Response.json({ error: 'bad seg id' }, { status: 400 });
    }
    // Snapshot whichever frame extension currently exists BEFORE the delete
    // wipes it. frame.clear is a high-signal rejection event — Gemini learns
    // what the user explicitly removes by inspecting the deleted bytes.
    const timeline = (await getTimeline(id)) ?? [];
    const priorUrl = timeline.find((s) => s.id === seg)?.frame_url ?? null;
    const priorExt = extFromFrameUrl(priorUrl) || 'jpg';
    const deleteSnap = priorUrl ? await snapshotBeforeOverwrite(id, 'frames', seg, priorExt) : null;

    // Remove both the .jpg (image frames) and .mp4 (video frames) — at
    // most one exists per seg id but we don't know which without a
    // round-trip, so fire both deletes. removePath is a no-op on 404.
    await removePath(framePath(id, seg));
    await removePath(frameVideoPath(id, seg));

    let patched = false;
    const updated = timeline.map((s) => {
      if (s.id === seg && s.frame_url) {
        patched = true;
        const { frame_url, ...rest } = s;
        return rest;
      }
      return s;
    });
    if (patched) await putTimeline(id, updated);
    if (patched) {
      await appendChange(id, {
        type: 'frame.clear',
        seg_id: seg,
        before: priorUrl
          ? { frame_url: priorUrl, ...(deleteSnap ? { snapshot_url: deleteSnap.snapshot_url } : {}) }
          : undefined,
      });
    }
    return Response.json({ ok: true, patched });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
