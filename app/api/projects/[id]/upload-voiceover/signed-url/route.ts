// POST /api/projects/{id}/upload-voiceover/signed-url
//
// Issues a short-lived Supabase signed upload URL so the browser can PUT
// the audio bytes directly to storage. Avoids the Vercel serverless 4.5MB
// function body cap that made the data-URL path 413 on anything over ~3MB.
//
// Response: { signedUrl, path, token }

import { createClient } from '@supabase/supabase-js';
import { isLocalStorageMode } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) {
      return Response.json({ error: 'bad project id' }, { status: 400 });
    }

    const path = `projects/${id}/voiceover.mp3`;
    if (isLocalStorageMode()) {
      const origin = new URL(req.url).origin;
      return Response.json({
        signedUrl: `${origin}/api/local/upload?path=${encodeURIComponent(path)}`,
        path,
        token: 'local',
      });
    }

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return Response.json({ error: 'supabase env missing' }, { status: 500 });
    }

    const bucket = (process.env.SUPABASE_BUCKET || 'wm-contact-sheet').trim();
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const { data, error } = await sb.storage
      .from(bucket)
      .createSignedUploadUrl(path, { upsert: true });

    if (error || !data) {
      return Response.json(
        { error: `signed url: ${error?.message || 'no data'}` },
        { status: 500 },
      );
    }

    return Response.json({
      signedUrl: data.signedUrl,
      path: data.path,
      token: data.token,
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
