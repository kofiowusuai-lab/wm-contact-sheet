// POST /api/projects/{id}/transcribe [{ audio_url? }]
//   Fetches voiceover.mp3 blob (or the provided audio_url), POSTs it to OpenAI
//   whisper-1 with word-level timestamps, writes words.json blob.

import { getVoiceoverUrl, putWords, type WordsDoc } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 60;

const OPENAI = 'https://api.openai.com/v1/audio/transcriptions';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return Response.json({ error: 'OPENAI_API_KEY missing' }, { status: 500 });

    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const audio_url = String(body?.audio_url || '') || (await getVoiceoverUrl(id));
    if (!audio_url) return Response.json({ error: 'no voiceover blob; run /tts first' }, { status: 400 });

    const audioResp = await fetch(audio_url);
    if (!audioResp.ok) return Response.json({ error: `audio fetch ${audioResp.status}` }, { status: 500 });
    const bytes = Buffer.from(await audioResp.arrayBuffer());

    const form = new FormData();
    form.append('file', new Blob([bytes as any], { type: 'audio/mpeg' }), 'voiceover.mp3');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    // Request BOTH granularities — "segment" gives natural sentence boundaries,
    // "word" gives word-level timestamps we keep around as a fallback.
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');

    const r = await fetch(OPENAI, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form as any,
    });
    if (!r.ok) {
      const t = await r.text();
      return Response.json({ error: `whisper ${r.status}: ${t.slice(0, 300)}` }, { status: 500 });
    }
    const data = (await r.json()) as {
      text: string;
      duration: number;
      words?: Array<{ word: string; start: number; end: number }>;
      segments?: Array<{ start: number; end: number; text: string; id?: number }>;
    };
    const words = data.words || [];
    const segments = (data.segments || []).map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: (s.text || '').trim(),
    }));
    const doc: WordsDoc = {
      total_words: words.length,
      total_duration: data.duration,
      words,
      full_text: data.text,
      segments,
    };
    await putWords(id, doc);
    return Response.json({
      ok: true,
      total_words: doc.total_words,
      total_duration: doc.total_duration,
      segments: segments.length,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
