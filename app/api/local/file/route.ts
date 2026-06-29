import { readLocalFile } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pathname = url.searchParams.get('path') || '';
  if (!pathname) return new Response('path required', { status: 400 });

  const file = await readLocalFile(pathname);
  if (!file) return new Response('not found', { status: 404 });

  return new Response(new Uint8Array(file.body), {
    headers: {
      'Content-Type': file.contentType,
      'Cache-Control': 'no-store',
    },
  });
}
