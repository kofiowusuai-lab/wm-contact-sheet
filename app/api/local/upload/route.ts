import { isLocalStorageMode, publicUrl, safeLocalPath, writeLocalFile } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function PUT(req: Request) {
  if (!isLocalStorageMode()) {
    return new Response('local upload is only available in local harness mode', { status: 404 });
  }

  const url = new URL(req.url);
  const pathname = url.searchParams.get('path') || '';
  if (!pathname) return new Response('path required', { status: 400 });

  try {
    safeLocalPath(pathname);
  } catch {
    return new Response('bad path', { status: 400 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  await writeLocalFile(pathname, body);

  return Response.json({
    ok: true,
    path: pathname,
    public_url: publicUrl(pathname, false),
    bytes: body.length,
  });
}
