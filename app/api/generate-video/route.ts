// POST /api/generate-video
//
// Submits a text-to-video generation to FAL's Bytedance Seedance model.
// Returns the queue URLs — clients poll the existing /api/generate-status
// endpoint (which already works on any FAL queue response).
//
// Body: {
//   prompt: string,
//   aspect?: '16:9' | '9:16' | '1:1' | '4:5',
//   duration?: number,                 // seconds, default 5
//   resolution?: '480p' | '720p' | '1080p',
// }
//
// Response: { request_id, status_url, response_url, model_id }

export const runtime = 'nodejs';
export const maxDuration = 30;

// Same aspect options exposed everywhere else in the app. Seedance accepts
// ratio strings directly; we pass "16:9", "9:16", etc.
const VALID_ASPECTS = new Set(['16:9', '9:16', '1:1']);

export async function POST(req: Request) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) {
    return Response.json({ error: 'FAL_KEY not configured' }, { status: 500 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.prompt) {
    return Response.json({ error: 'prompt required' }, { status: 400 });
  }
  const prompt = String(body.prompt).trim();
  const aspect = typeof body.aspect === 'string' && VALID_ASPECTS.has(body.aspect)
    ? (body.aspect as string)
    : '16:9';
  const duration = Math.max(3, Math.min(12, Number(body.duration) || 5));
  const resolution = body.resolution === '1080p' ? '1080p' : body.resolution === '480p' ? '480p' : '720p';

  // Bytedance Seedance 2.0 text-to-video on FAL. Endpoint path matches
  // FAL's routing convention: fal-ai/<owner>/<model>/<mode>.
  const model_id = 'fal-ai/bytedance/seedance/v1/lite/text-to-video';
  const falBody: Record<string, unknown> = {
    prompt,
    aspect_ratio: aspect,
    duration: String(duration),
    resolution,
  };

  const res = await fetch(`https://queue.fal.run/${model_id}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(falBody),
  });
  if (!res.ok) {
    const t = await res.text();
    return Response.json(
      { error: `FAL submit failed: ${res.status} ${t.slice(0, 300)}` },
      { status: 500 },
    );
  }
  const sub = await res.json() as {
    request_id: string;
    status_url: string;
    response_url: string;
  };
  return Response.json({
    request_id: sub.request_id,
    status_url: sub.status_url,
    response_url: sub.response_url,
    model_id,
  });
}
