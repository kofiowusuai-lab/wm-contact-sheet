// POST /api/projects/{id}/frames/{seg}/signed-url
//
// Issues a short-lived Supabase signed upload URL so the browser can PUT
// frame bytes (image OR video) straight to storage. Avoids the Vercel
// serverless 4.5MB function body cap that breaks the data-URL path on any
// modern .mp4. Mirrors the upload-voiceover/signed-url pattern.
//
// Body: { ext: 'mp4' | 'jpg' | 'png' | 'webm' }  (default 'mp4')
// Response: { signedUrl, path, token, public_url }

import { createClient } from '@supabase/supabase-js';
import { isLocalStorageMode, publicUrl } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string; seg: string }> };

const ALLOWED_EXTS = new Set(['mp4', 'webm', 'mov', 'jpg', 'jpeg', 'png']);

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, seg } = await ctx.params;
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) {
      return Response.json({ error: 'bad project id' }, { status: 400 });
    }
    if (!/^[A-Za-z0-9_\-]+$/.test(seg)) {
      return Response.json({ error: 'bad seg id' }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const rawExt = String(body?.ext || 'mp4').toLowerCase().replace(/^\./, '');
    if (!ALLOWED_EXTS.has(rawExt)) {
      return Response.json({ error: `unsupported ext: ${rawExt}` }, { status: 400 });
    }
    // Normalise: jpeg→jpg so the storage key matches the existing framePath.
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    const path = `projects/${id}/frames/${seg}.${ext}`;

    if (isLocalStorageMode()) {
      const origin = new URL(req.url).origin;
      return Response.json({
        signedUrl: `${origin}/api/local/upload?path=${encodeURIComponent(path)}`,
        path,
        token: 'local',
        public_url: publicUrl(path, false),
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
      public_url: publicUrl(path, false),
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
