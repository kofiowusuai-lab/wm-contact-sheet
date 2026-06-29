// POST /api/ai/draft-episode
//
// Takes the intake-form answers and returns a Gemini-drafted episode:
// { script, characters: [{tag, description, voice_hints}], narrator_hint }.
//
// Nothing is persisted — the client shows the draft in the orchestrator
// modal so the user can tweak the script + roster before committing.
//
// The client does subsequent create-series / create-episode / write-script
// calls against existing endpoints once the user confirms.

import { getSeriesMeta } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_MODEL = 'gemini-2.5-flash';

type DraftBody = {
  series_id?: string;
  series_title?: string;
  series_description?: string;
  title: string;
  aspect?: '16:9' | '9:16' | '1:1' | '4:5';
  runtime?: 'short' | 'long';
  speaker_hint?: number;
  theme?: string;
  names?: string[];
  style_anchor?: string;
};

type DraftResult = {
  script: string;
  characters: { tag: string; description: string; voice_hints: string }[];
  narrator_hint: string;
};

async function gemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 503 || r.status === 429) {
      lastErr = new Error(`${r.status} ${text.slice(0, 100)}`);
      await new Promise((res) => setTimeout(res, 1500 * attempt));
      continue;
    }
    if (!r.ok) throw new Error(`gemini ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) throw new Error(`gemini empty response: ${text.slice(0, 300)}`);
    return out;
  }
  throw lastErr ?? new Error('gemini exhausted retries');
}

function buildPrompt(b: DraftBody): string {
  const runtime = b.runtime === 'short' ? 'short vertical' : 'long-form';
  const beatTarget = b.runtime === 'short'
    ? '40–55 seconds of voice-over, roughly 120–150 words, 6–10 beats'
    : '8:00–8:30 minutes of voice-over, roughly 1900–2100 words, 60–100 beats';
  const aspectWord = b.aspect === '9:16' ? 'vertical 9:16' : 'horizontal 16:9';
  const speakers = b.speaker_hint ?? 0;
  const namesClause = b.names && b.names.length > 0
    ? `The dialogue characters should be: ${b.names.join(', ')}.`
    : 'Invent distinct, memorable dialogue-character names.';
  const seriesBlock = b.series_title
    ? `SERIES: "${b.series_title}"${b.series_description ? ` — ${b.series_description}` : ''}`
    : 'SERIES: (standalone one-off — invent a tone that fits the theme below.)';
  const styleLine = b.style_anchor
    ? `\nSTYLE DIRECTIVE (visual + tonal): ${b.style_anchor}`
    : '';
  const speakerRules = speakers > 0
    ? `SPEAKERS: include exactly ${speakers} named dialogue character${speakers === 1 ? '' : 's'} plus the narrator. Every dialogue line MUST start with "@NAME: " (uppercase tag, one per line). Plain-prose lines without a tag are read by the narrator. ${namesClause}`
    : 'SPEAKERS: narration-only (no @NAME tags). Every line is narrator voice.';

  return `You are a senior scriptwriter. Draft a complete ${runtime} episode ready for text-to-speech voice-over.

${seriesBlock}${styleLine}

EPISODE TITLE: "${b.title}"
THEME / PREMISE: ${b.theme || '(none supplied — write something compelling that fits the series)'}

LENGTH: ${beatTarget}.
ASPECT: ${aspectWord}.
${speakerRules}

Return STRICT JSON (no markdown fences, no preamble) with exactly this shape:

{
  "script": "full episode script body as plain text. Include @NAME: tags on dialogue lines only. Do not add scene headings, stage directions, or bracketed cues — the script you return is piped verbatim into ElevenLabs TTS.",
  "characters": [
    {
      "tag": "SHORTUPPERCASETAG",
      "description": "one-sentence visual description for a character portrait (age, race, body type, wardrobe, distinguishing features). Keep it specific so an image model can render it.",
      "voice_hints": "short adjective string for matching an ElevenLabs voice — e.g. 'young male warm american', 'older female gravelly british'. Max 60 chars."
    }
  ],
  "narrator_hint": "short adjective string for the narrator voice — same style as voice_hints."
}

The characters array MUST contain one entry per @NAME tag used in the script (in order of first appearance). If the script is narration-only, return an empty characters array. Tags in the array must EXACTLY match the @NAME tags used inside the script — uppercase, letters/digits/underscores only.`;
}

function sanitiseScript(raw: string): string {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function normaliseTag(tag: string): string {
  return String(tag || '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as DraftBody | null;
    if (!body || !body.title) {
      return Response.json({ error: 'title required' }, { status: 400 });
    }

    // Hydrate series context if an id was supplied and it exists on disk.
    if (body.series_id && !body.series_title) {
      const s = await getSeriesMeta(body.series_id);
      if (s) {
        body.series_title = s.title;
        body.series_description = s.description || '';
      }
    }

    const prompt = buildPrompt(body);
    const raw = await gemini(prompt);

    let parsed: DraftResult;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Strip any accidental markdown fences and retry parse
      const stripped = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      parsed = JSON.parse(stripped);
    }

    const script = sanitiseScript(parsed.script);
    const characters = Array.isArray(parsed.characters)
      ? parsed.characters
          .map((c) => ({
            tag: normaliseTag(c?.tag ?? ''),
            description: String(c?.description || '').slice(0, 400).trim(),
            voice_hints: String(c?.voice_hints || '').slice(0, 80).trim(),
          }))
          .filter((c) => c.tag.length > 0)
      : [];
    const narrator_hint = String(parsed.narrator_hint || '').slice(0, 80).trim();

    return Response.json({ script, characters, narrator_hint });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
