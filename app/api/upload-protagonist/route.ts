// Upload a protagonist reference image (data URL from browser) to FAL storage
// and return the hosted URL. Client stores this URL in localStorage and
// reuses it for every Kontext generation.
//
// Two-step FAL storage flow:
//   1) POST /storage/upload/initiate_multipart -> gets {upload_url, file_url}
//      (for small files we can just use /storage/upload which is simpler)
//   2) For simplicity here we use the single-PUT endpoint:
//      POST https://rest.fal.ai/storage/upload  (content-type is the image mime)

export const runtime = 'nodejs';
export const maxDuration = 30;

function parseDataUrl(dataUrl: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

export async function POST(req: Request) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) {
    return Response.json({ error: 'FAL_KEY not configured' }, { status: 500 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.data_url) {
    return Response.json({ error: 'data_url required' }, { status: 400 });
  }
  const parsed = parseDataUrl(body.data_url);
  if (!parsed) {
    return Response.json({ error: 'invalid data_url' }, { status: 400 });
  }

  // Step 1: initiate upload to get a signed URL
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content_type: parsed.mime,
      file_name: `protagonist_${Date.now()}.${parsed.mime.split('/')[1] || 'jpg'}`,
    }),
  });
  if (!initResp.ok) {
    const t = await initResp.text();
    return Response.json(
      { error: `initiate failed: ${initResp.status} ${t.slice(0, 200)}` },
      { status: 500 },
    );
  }
  const init = await initResp.json() as { upload_url: string; file_url: string };

  // Step 2: PUT the bytes to the signed URL
  const putResp = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': parsed.mime },
    body: parsed.buf as any,
  });
  if (!putResp.ok) {
    return Response.json(
      { error: `upload PUT failed: ${putResp.status}` },
      { status: 500 },
    );
  }

  // Optionally persist for a project so other browsers see the same protagonist
  if (body?.project_id && typeof body.project_id === 'string') {
    try {
      const { putProtagonist } = await import('@/app/lib/blob');
      await putProtagonist(body.project_id, init.file_url);
    } catch {
      // non-fatal: return the URL either way
    }
  }

  return Response.json({ url: init.file_url });
}
