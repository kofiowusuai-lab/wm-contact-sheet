// POST /api/projects/{id}/voiceovers/append
//   { text, voice_id?, voice_name?, model_id? }
// Generates TTS for the given text in the project's active voice, concatenates
// the MP3 bytes onto the end of voiceover.mp3, runs Whisper on the new clip
// to get word-level timings, and appends a new timeline entry.
//
// The VO_NNN id picks up from the highest existing numeric id + 1. Existing
// segments and their frame_urls are untouched — the render for earlier rows
// stays identical.

import {
  getMeta,
  putMeta,
  getTimeline,
  putTimeline,
  putVoiceover,
  projectPath,
  readJson as storageReadJson,
  readLocalFile,
  writeJson as storageWriteJson,
} from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';
import { snapshotBeforeOverwrite } from '@/app/lib/snapshots';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const XI = 'https://api.elevenlabs.io';
const OPENAI = 'https://api.openai.com';

async function elevenTts(key: string, voice_id: string, model_id: string, text: string): Promise<Buffer> {
  const url = `${XI}/v1/text-to-speech/${voice_id}?output_format=mp3_44100_128`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

type WhisperWord = { word: string; start: number; end: number };
type WhisperResp = { duration: number; text: string; words: WhisperWord[] };

async function whisperWords(openaiKey: string, mp3: Buffer): Promise<WhisperResp> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(mp3)], { type: 'audio/mpeg' }), 'clip.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  const r = await fetch(`${OPENAI}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as WhisperResp;
}

async function lookupVoiceId(elKey: string, name: string): Promise<string | null> {
  const r = await fetch(`${XI}/v1/voices`, { headers: { 'xi-api-key': elKey }, cache: 'no-store' });
  if (!r.ok) return null;
  const data = (await r.json()) as { voices: { voice_id: string; name: string }[] };
  const hit = (data.voices || []).find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
  return hit?.voice_id ?? null;
}

// --- words.json helpers -----------------------------------------------------

type WordsDoc = { total_words?: number; total_duration?: number; words?: WhisperWord[]; full_text?: string };

async function readJson<T>(pathname: string): Promise<T | null> {
  return storageReadJson<T>(pathname);
}

async function writeJson(pathname: string, doc: unknown): Promise<void> {
  await storageWriteJson(pathname, doc);
}

async function readBinary(pathname: string): Promise<Buffer | null> {
  const local = await readLocalFile(pathname);
  if (local) return local.body;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET || 'wm-contact-sheet';
  if (!url || !key) return null;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.storage.from(bucket).download(pathname);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

// --- main -------------------------------------------------------------------

type Ctx = { params: Promise<{ id: string }> };

function nextVoId(existing: string[]): string {
  let max = -1;
  for (const id of existing) {
    const m = /^VO_(\d+)/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `VO_${String(max + 1).padStart(3, '0')}`;
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const elKey = process.env.ELEVENLABS_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!elKey) return Response.json({ error: 'ELEVENLABS_API_KEY missing' }, { status: 500 });
    if (!openaiKey) return Response.json({ error: 'OPENAI_API_KEY missing' }, { status: 500 });

    const body = await req.json().catch(() => ({}));
    const text = String(body?.text || '').trim();
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });
    const voiceIdArg = String(body?.voice_id || '').trim();
    const voiceNameArg = String(body?.voice_name || '').trim();
    const modelId = String(body?.model_id || '').trim() || 'eleven_v3';

    // Resolve the voice: explicit arg wins, else project meta, else name lookup.
    const meta = await getMeta(id);
    let voiceId = voiceIdArg || meta?.voice_id || '';
    if (!voiceId && voiceNameArg) {
      voiceId = (await lookupVoiceId(elKey, voiceNameArg)) || '';
    }
    if (!voiceId) {
      return Response.json({ error: 'voice_id unresolved — pass voice_id or voice_name' }, { status: 400 });
    }

    // TTS the text
    const newMp3 = await elevenTts(elKey, voiceId, modelId, text);

    // Whisper the NEW clip alone to get local-time word timings
    const whisper = await whisperWords(openaiKey, newMp3);
    const newDuration = whisper.duration || 0;
    if (!newDuration) {
      return Response.json({ error: 'whisper returned no duration' }, { status: 500 });
    }

    // Fetch current voiceover + words.json to compute offset and merge.
    const currentMp3 = (await readBinary(projectPath(id, 'voiceover.mp3'))) ?? Buffer.alloc(0);
    const existingWords = (await readJson<WordsDoc>(projectPath(id, 'words.json'))) ?? {
      words: [],
      total_duration: 0,
    };
    const offset = Number(existingWords.total_duration || 0);

    // Snapshot the active voiceover.mp3 BEFORE appending. The append-extended
    // file overwrites the old one, so without this the old audio is gone for
    // Gemini diff purposes.
    const voSnap = await snapshotBeforeOverwrite(id, 'voiceover', 'main', 'mp3');

    // Concatenate raw MP3 bytes — ElevenLabs uses consistent mp3_44100_128 so
    // naive concat is safe (same pattern used by the existing /tts route).
    const extendedMp3 = Buffer.concat([currentMp3, newMp3]);
    const newVoUrl = await putVoiceover(id, extendedMp3);

    // Offset new whisper words and merge into words.json
    const offsetWords: WhisperWord[] = (whisper.words || []).map((w) => ({
      word: w.word,
      start: Number(w.start) + offset,
      end: Number(w.end) + offset,
    }));
    const mergedWords = [...(existingWords.words || []), ...offsetWords];
    const newTotalDuration = offset + newDuration;
    const mergedText = ((existingWords.full_text || '') + ' ' + (whisper.text || '')).trim();
    await writeJson(projectPath(id, 'words.json'), {
      total_words: mergedWords.length,
      total_duration: newTotalDuration,
      words: mergedWords,
      full_text: mergedText,
    });

    // Append a new timeline row. Start = offset, end = offset+duration.
    const timeline = (await getTimeline(id)) ?? [];
    const existingIds = timeline.map((s) => s.id);
    const newId = nextVoId(existingIds);
    const start = Number(offset.toFixed(3));
    const end = Number(newTotalDuration.toFixed(3));
    const entry = {
      id: newId,
      start,
      end,
      duration: Number((end - start).toFixed(3)),
      narration: text,
      ken_burns: ['zoom_in', 'pan_right', 'push_in', 'pan_left'][timeline.length % 4] as
        | 'zoom_in'
        | 'pan_right'
        | 'push_in'
        | 'pan_left',
      kind: 'vo' as const,
    };
    const newTimeline = [...timeline, entry].sort(
      (a, b) => Number(a.start ?? 0) - Number(b.start ?? 0),
    );
    await putTimeline(id, newTimeline);

    // Keep meta.voice_id up to date for future appends.
    if (meta && meta.voice_id !== voiceId) {
      meta.voice_id = voiceId;
      meta.model_id = modelId;
      meta.updated_at = new Date().toISOString();
      await putMeta(meta);
    }

    // Emit voiceover.append so the puller picks it up + Gemini diffs the
    // appended audio against the snapshot of the prior voiceover.
    await appendChange(id, {
      type: 'voiceover.append',
      seg_id: newId,
      before: voSnap
        ? { voiceover_url: undefined, snapshot_url: voSnap.snapshot_url }
        : undefined,
      after: { voiceover_url: newVoUrl, segment_id: newId, narration: text },
      meta: {
        appended_bytes: newMp3.length,
        appended_duration_s: newDuration,
        total_duration_s: newTotalDuration,
        voice_id: voiceId,
      },
    });

    return Response.json({
      ok: true,
      segment: entry,
      voiceover_bytes: extendedMp3.length,
      total_duration: newTotalDuration,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
