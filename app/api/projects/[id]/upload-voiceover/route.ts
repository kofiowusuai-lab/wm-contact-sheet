// POST /api/projects/{id}/upload-voiceover
//
// Two body shapes:
//
//  A) { uploaded: true, mime, bytes }
//     The browser already PUT the bytes straight to Supabase via the
//     /signed-url sibling route. Server just stamps metadata.
//     Preferred for anything over a couple MB — Vercel serverless
//     function bodies cap at ~4.5MB.
//
//  B) { data_url: "data:audio/mp4;base64,…" }  (legacy / tiny files only)
//     Server decodes and writes to Supabase itself.
//
// Accepted mimes match OpenAI Whisper: audio/mpeg, audio/mp4, audio/wav,
// audio/webm, video/mp4, video/webm, etc.
//
// Response: { ok: true, audio_url, bytes, content_type }

import {
  putVoiceover,
  getMeta,
  putMeta,
  publicUrl,
  projectPath,
  recordVoiceoverGeneration,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 25 * 1024 * 1024; // Whisper API hard limit

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

async function stampMeta(id: string, audio_url: string, bytes: number, mime: string) {
  await recordVoiceoverGeneration(id, {
    voice_id: 'uploaded',
    voice_name: 'User upload',
    url: audio_url,
    bytes,
    generated_at: new Date().toISOString(),
    model_id: `upload/${mime}`,
  });

  const meta = await getMeta(id);
  if (meta) {
    meta.voice_id = 'uploaded';
    meta.voice_name = 'User upload';
    meta.active_voice_id = 'uploaded';
    meta.updated_at = new Date().toISOString();
    await putMeta(meta);
  }
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);

    // Path A — client already uploaded to Supabase via signed URL.
    if (body?.uploaded) {
      const bytes = Number(body.bytes) || 0;
      const mime = String(body.mime || 'audio/mpeg');
      if (bytes > MAX_BYTES) {
        return Response.json(
          { error: `file too large (${bytes} bytes) — Whisper caps uploads at 25MB` },
          { status: 413 },
        );
      }
      const audio_url = publicUrl(projectPath(id, 'voiceover.mp3'), false);
      await stampMeta(id, audio_url, bytes, mime);
      return Response.json({ ok: true, audio_url, bytes, content_type: mime });
    }

    // Path B — legacy data_url (small files only; Vercel body cap ~4.5MB).
    if (!body?.data_url) {
      return Response.json({ error: 'data_url or uploaded required' }, { status: 400 });
    }
    const parsed = parseDataUrl(String(body.data_url));
    if (!parsed) {
      return Response.json({ error: 'invalid data_url' }, { status: 400 });
    }
    if (parsed.buf.length > MAX_BYTES) {
      return Response.json(
        { error: `file too large (${parsed.buf.length} bytes) — Whisper caps uploads at 25MB` },
        { status: 413 },
      );
    }

    const audio_url = await putVoiceover(id, parsed.buf, parsed.mime);
    await stampMeta(id, audio_url, parsed.buf.length, parsed.mime);

    return Response.json({
      ok: true,
      audio_url,
      bytes: parsed.buf.length,
      content_type: parsed.mime,
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
