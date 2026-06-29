// Minimal Gemini REST client. Server-side only — never expose GEMINI_API_KEY
// to the browser. Uses 2.5-flash by default (cheap + fast enough for our
// long-context summarization use case).

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export type GeminiImageInput =
  | { url: string; mimeType?: string }
  | { base64: string; mimeType: string };

export type GeminiOptions = {
  model?: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** If true, constrains the response to parseable JSON. */
  json?: boolean;
  /**
   * Multimodal images. URLs are fetched server-side and inlined as base64
   * (mirrors the working pattern in `describeLocation` below). Base64 inputs
   * skip the fetch. Order is preserved — pair before/after frames adjacent
   * for diff prompts.
   */
  images?: GeminiImageInput[];
};

async function fetchImagePart(input: GeminiImageInput): Promise<{ inlineData: { mimeType: string; data: string } }> {
  if ('base64' in input) {
    return { inlineData: { mimeType: input.mimeType, data: input.base64 } };
  }
  const r = await fetch(input.url);
  if (!r.ok) throw new Error(`gemini image fetch ${r.status} for ${input.url.slice(0, 100)}`);
  const mime = input.mimeType || r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  return { inlineData: { mimeType: mime, data: buf.toString('base64') } };
}

export async function geminiGenerate(prompt: string, opts: GeminiOptions = {}): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const model = opts.model || DEFAULT_MODEL;

  // Build parts: text first, then any images (Gemini accepts mixed parts in
  // a single user turn — that's how describeLocation works).
  const parts: any[] = [{ text: prompt }];
  if (opts.images?.length) {
    // Fetch all images in parallel — at typical 8-pair caps that's ~16 fetches
    // which Vercel handles in <2s combined.
    const imageParts = await Promise.all(opts.images.map(fetchImagePart));
    parts.push(...imageParts);
  }

  const body: any = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (opts.system) {
    body.systemInstruction = { role: 'system', parts: [{ text: opts.system }] };
  }

  const r = await fetch(`${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gemini ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = (await r.json()) as any;
  const candidate = data?.candidates?.[0];
  const respParts = candidate?.content?.parts ?? [];
  const text = respParts
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) {
    const blocked = candidate?.finishReason ?? 'empty';
    throw new Error(`gemini returned no text (${blocked})`);
  }
  return text;
}

// Multimodal helper: Gemini reads a location master image and returns a 3-5
// sentence canonical prose description used to lock the environment across
// future image generations. Downloads the image, sends it inline as base64.
export async function describeLocation(imageUrl: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY missing');

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`fetch image failed: ${imgRes.status}`);
  const mime = imgRes.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const b64 = buf.toString('base64');

  const system = [
    'You describe a location as a 3-5 sentence canonical prose lock for use in image-generation prompts.',
    'Mandatory elements in order:',
    '(1) Wall and ceiling colors / materials.',
    '(2) Light source, direction, time of day if inferable.',
    '(3) Three named fixed objects with positions (left / center / right / upstage / downstage).',
    '(4) Dominant color palette (2-3 colors).',
    '(5) One camera-friendly framing hint (e.g. "doorway POV: bed-left / window-center / desk-right").',
    'Present tense, no first-person, no character descriptions. Output prose only — no bullets, no headings, no markdown.',
  ].join(' ');

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Describe this location as a canonical prose lock.' },
          { inlineData: { mimeType: mime, data: b64 } },
        ],
      },
    ],
    systemInstruction: { role: 'system', parts: [{ text: system }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
  };

  const r = await fetch(
    `${GEMINI_URL}/${DEFAULT_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gemini describe ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = (await r.json()) as any;
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) throw new Error('gemini returned no description');
  return text;
}
