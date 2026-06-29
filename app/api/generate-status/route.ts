// Poll a FAL job using the status_url + response_url returned from submit.
// If COMPLETED, fetch the result and return the first image URL.
//
// Accepts EITHER:
//   GET  ?status_url=...&response_url=...
//   POST {status_url, response_url}

export const runtime = 'nodejs';
export const maxDuration = 10;

async function doCheck(statusUrl: string, responseUrl: string) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error('FAL_KEY not configured');

  // Only allow queue.fal.run hosts for safety
  const host = (u: string) => new URL(u).host;
  if (host(statusUrl) !== 'queue.fal.run' || host(responseUrl) !== 'queue.fal.run') {
    throw new Error('invalid host');
  }

  const sResp = await fetch(statusUrl, {
    headers: { Authorization: `Key ${FAL_KEY}` },
  });
  if (!sResp.ok) throw new Error(`status ${sResp.status}`);
  const status = await sResp.json() as { status: string; [k: string]: any };
  if (status.status !== 'COMPLETED') {
    return { done: false, status: status.status, queue_position: status.queue_position ?? null };
  }

  const rResp = await fetch(responseUrl, {
    headers: { Authorization: `Key ${FAL_KEY}` },
  });
  if (!rResp.ok) throw new Error(`result ${rResp.status}`);
  const result = await rResp.json() as {
    images?: { url: string }[];
    video?: { url: string } | string;
  };
  // Image generators return { images: [{ url }, …] }; video models (seedance,
  // sora, etc.) return { video: { url } } or a bare { video: "url" }. We
  // return whichever is present so the client can decide how to persist.
  const imgUrl = result.images?.[0]?.url;
  const videoUrl =
    typeof result.video === 'string'
      ? result.video
      : result.video?.url;
  if (videoUrl) {
    return { done: true, status: 'COMPLETED', video_url: videoUrl };
  }
  if (imgUrl) {
    return { done: true, status: 'COMPLETED', image_url: imgUrl };
  }
  throw new Error('no image or video in result');
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const su = u.searchParams.get('status_url');
    const ru = u.searchParams.get('response_url');
    if (!su || !ru) {
      return Response.json({ error: 'status_url and response_url required' }, { status: 400 });
    }
    const out = await doCheck(su, ru);
    return Response.json(out);
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body?.status_url || !body?.response_url) {
      return Response.json({ error: 'status_url and response_url required' }, { status: 400 });
    }
    const out = await doCheck(body.status_url, body.response_url);
    return Response.json(out);
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 500 });
  }
}
