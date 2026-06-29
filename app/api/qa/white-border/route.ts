// POST /api/qa/white-border { image_url }
//   Downloads the image, sends it to Gemini 2.5 Flash with a narrow
//   yes/no prompt ("is this a bordered / matted illustration?"), returns
//   { has_border, reason }. Called per-frame from the client so the client
//   can fan out 8+ requests in parallel and stream progress into the UI —
//   a single batched server endpoint would hit Vercel's 60s cap long before
//   111 frames complete.

export const runtime = 'nodejs';
export const maxDuration = 20;

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

const USER_PROMPT = [
  'Look carefully at the outermost 4% of this image on ALL four sides.',
  'Is there a visible strip of solid off-white, cream, beige, or pale grey forming an unwanted decorative margin around the illustration — as if the artwork were printed inside a page matte?',
  'This is DIFFERENT from a light-colored wall, ceiling, or sky that belongs to the scene: a matte is a FLAT uniform strip running continuously along the edges, not shaded in-scene geometry.',
  '',
  'Answer on the FIRST LINE with exactly one word: YES or NO.',
  'On a SECOND LINE write one sentence describing what you see at the image edges.',
].join('\n');

export async function POST(req: Request) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return Response.json({ error: 'GEMINI_API_KEY missing' }, { status: 500 });
    const body = await req.json().catch(() => null);
    const imageUrl = String(body?.image_url || '').trim();
    if (!imageUrl) return Response.json({ error: 'image_url required' }, { status: 400 });

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      return Response.json({ error: `fetch image ${imgRes.status}` }, { status: 502 });
    }
    const mime = imgRes.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const b64 = buf.toString('base64');

    const reqBody = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: USER_PROMPT },
            { inlineData: { mimeType: mime, data: b64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        // Plain text YES/NO plus a sentence — JSON mode was causing Gemini to
        // silently default to `has_border: false` on any ambiguity, even when
        // the border was visually obvious. Raw text is more reliable here.
        maxOutputTokens: 300,
      },
    };

    const r = await fetch(
      `${GEMINI_URL}/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      },
    );
    if (!r.ok) {
      return Response.json({ error: `gemini ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 });
    }
    const data: any = await r.json();
    const raw = ((data?.candidates?.[0]?.content?.parts ?? []) as any[])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
    const head = firstLine.toUpperCase();
    // Accept any YES-leading verdict; strip punctuation so "YES." / "YES!" still match.
    const has_border = /^YES\b/.test(head);
    const reason = (raw.split(/\r?\n/).slice(1).join(' ').trim() || firstLine).slice(0, 200);
    return Response.json({ has_border, reason, raw_preview: raw.slice(0, 200) });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
