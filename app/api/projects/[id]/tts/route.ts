// POST /api/projects/{id}/tts { voice_id, model_id? }
//   Reads projects/{id}/script.txt, chunks to ≤2500 chars at paragraph boundaries,
//   calls ElevenLabs per chunk, concatenates MP3 bytes, writes voiceover.mp3 blob.

import {
  getScript,
  putVoiceover,
  getMeta,
  putMeta,
  putVoiceoverForVoice,
  recordVoiceoverGeneration,
} from '@/app/lib/blob';
import { appendChange } from '@/app/lib/changelog';
import { snapshotBeforeOverwrite } from '@/app/lib/snapshots';

export const runtime = 'nodejs';
export const maxDuration = 60;

const XI = 'https://api.elevenlabs.io';
const MAX_CHUNK = 2400;

function chunk(text: string, max = MAX_CHUNK): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).trim().length <= max) {
      buf = buf ? buf + '\n\n' + p : p;
    } else {
      if (buf) out.push(buf);
      if (p.length <= max) {
        buf = p;
      } else {
        // split on sentence boundaries if a single paragraph exceeds the cap
        const parts = p.split(/(?<=[.!?])\s+/);
        let sub = '';
        for (const s of parts) {
          if ((sub + ' ' + s).trim().length <= max) sub = (sub ? sub + ' ' : '') + s;
          else {
            if (sub) out.push(sub);
            sub = s;
          }
        }
        if (sub) buf = sub; else buf = '';
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Quota / credit-exhausted error signatures from ElevenLabs. 401 typically means
// the key was revoked; 402 + "quota_exceeded" means the account ran out of
// credits. Both trigger the fallback key if one is configured.
function isCreditError(status: number, body: string): boolean {
  if (status === 402) return true;
  if (status === 401 && /quota|credit|invalid.?api.?key/i.test(body)) return true;
  if (status === 429 && /quota|credit/i.test(body)) return true;
  return false;
}

async function ttsCall(key: string, voice_id: string, model_id: string, text: string,
                       voice_settings?: unknown): Promise<{ ok: true; buf: Buffer } | { ok: false; status: number; body: string }> {
  const url = `${XI}/v1/text-to-speech/${voice_id}?output_format=mp3_44100_128`;
  const payload: Record<string, unknown> = { text, model_id };
  if (voice_settings) payload.voice_settings = voice_settings;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, body: t };
  }
  const ab = await r.arrayBuffer();
  return { ok: true, buf: Buffer.from(ab) };
}

async function ttsOne(key: string, voice_id: string, model_id: string, text: string,
                      voice_settings?: unknown): Promise<Buffer> {
  // Try primary then each configured fallback in order. Each fallback is
  // consulted only on a credit/quota error (isCreditError) — other errors
  // fail fast because they indicate real problems (bad voice_id, malformed
  // body, ElevenLabs outage) where retrying with a different key won't help.
  const keys = [
    { label: 'primary', key },
    { label: 'fallback', key: process.env.ELEVENLABS_API_KEY_FALLBACK },
    { label: 'fallback_2', key: process.env.ELEVENLABS_API_KEY_FALLBACK_2 },
    { label: 'fallback_3', key: process.env.ELEVENLABS_API_KEY_FALLBACK_3 },
  ].filter((k): k is { label: string; key: string } => Boolean(k.key));

  let last: { status: number; body: string } | null = null;
  for (let i = 0; i < keys.length; i++) {
    const { label, key: k } = keys[i];
    const r = await ttsCall(k, voice_id, model_id, text, voice_settings);
    if (r.ok) {
      if (i > 0) console.warn(`[tts] succeeded on ${label} after ${i} credit-error(s)`);
      return r.buf;
    }
    last = { status: r.status, body: r.body };
    const keepGoing = i < keys.length - 1 && isCreditError(r.status, r.body);
    if (!keepGoing) break;
    console.warn(`[tts] ${label} hit ${r.status} (${r.body.slice(0, 120)}) — trying next key`);
  }
  throw new Error(`tts exhausted all keys — last ${last?.status}: ${(last?.body || '').slice(0, 200)}`);
}

// Each ElevenLabs mp3 chunk ships with a Xing/Info header frame at the start
// that tells players the chunk's duration. Naive Buffer.concat leaves every
// chunk's header in place and most browsers honor the first one, so the audio
// element reports a total duration that's just chunk-1's length — even though
// every byte of later chunks is playable. Stripping the Xing frame from
// chunks 2+ leaves a clean stream whose duration the browser computes from
// file size at the CBR bitrate. For a single chunk we pass through untouched.
const XING_SEARCH_LIMIT = 400;

function xingFrameSize(buf: Buffer, headerOffset: number): number | null {
  // Standard 44.1 kHz, 128 kbps, stereo → 417 or 418 bytes per frame depending
  // on the padding bit. We parse the header bits so we don't hardcode 417.
  if (buf.length < headerOffset + 4) return null;
  if (buf[headerOffset] !== 0xff) return null;
  if ((buf[headerOffset + 1] & 0xe0) !== 0xe0) return null;
  const b1 = buf[headerOffset + 1];
  const b2 = buf[headerOffset + 2];
  const versionBits = (b1 >> 3) & 0x03; // 11 = MPEG-1
  const layerBits = (b1 >> 1) & 0x03; // 01 = Layer III
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const samplingIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (versionBits !== 0x03 || layerBits !== 0x01) return null;
  // MPEG-1 Layer III bitrate table (kbps), index 1-14 valid.
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const SAMPLE_RATES = [44100, 48000, 32000];
  const bitrate = BITRATES[bitrateIdx];
  const sampleRate = SAMPLE_RATES[samplingIdx];
  if (!bitrate || !sampleRate) return null;
  return Math.floor((144 * bitrate * 1000) / sampleRate) + padding;
}

function stripXingFrame(buf: Buffer): Buffer {
  // The first MP3 frame is always at offset 0 for ElevenLabs responses.
  const size = xingFrameSize(buf, 0);
  if (!size) return buf;
  // Confirm this first frame is actually a Xing/Info header by looking for
  // the "Xing" or "Info" magic inside its payload window. We scan the first
  // XING_SEARCH_LIMIT bytes to tolerate variable side-info layouts.
  const scanEnd = Math.min(buf.length, XING_SEARCH_LIMIT);
  const xingIdx = buf.indexOf('Xing', 0, 'latin1');
  const infoIdx = buf.indexOf('Info', 0, 'latin1');
  const magicIdx = [xingIdx, infoIdx].filter((i) => i >= 0 && i < scanEnd).sort((a, b) => a - b)[0];
  if (magicIdx === undefined || magicIdx >= size) return buf;
  return buf.subarray(size);
}

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return Response.json({ error: 'ELEVENLABS_API_KEY missing' }, { status: 500 });
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const voice_id = String(body?.voice_id || '').trim();
    const voice_name = String(body?.voice_name || '').trim();
    const model_id = String(body?.model_id || 'eleven_v3');
    const voice_settings = body?.voice_settings;
    if (!voice_id) return Response.json({ error: 'voice_id required' }, { status: 400 });

    const script = (await getScript(id))?.trim();
    if (!script) return Response.json({ error: 'no script saved for project' }, { status: 400 });

    const chunks = chunk(script);
    const parts: Buffer[] = [];
    for (const c of chunks) {
      parts.push(await ttsOne(key, voice_id, model_id, c, voice_settings));
    }
    // For a single chunk the Xing header is accurate — leave it alone.
    // For multi-chunk output every chunk's header reports only that chunk's
    // length, and keeping any of them tells browsers to stop playback early.
    // Stripping all Xing frames makes browsers compute duration from file
    // size at the CBR bitrate, which is what we actually encoded at (128 kbps).
    const normalized = parts.length <= 1
      ? parts
      : parts.map(stripXingFrame);
    const mp3 = Buffer.concat(normalized);

    // Snapshot the active voiceover.mp3 BEFORE overwriting. Even though
    // voiceovers/{prior_voice_id}.mp3 keeps a per-voice archive, the snapshot
    // path gives Gemini a stable diff anchor without having to look up which
    // voice was previously active.
    const priorMeta = await getMeta(id);
    const priorVoiceId = priorMeta?.active_voice_id || priorMeta?.voice_id || null;
    const voSnap = await snapshotBeforeOverwrite(id, 'voiceover', 'main', 'mp3');

    const url = await putVoiceover(id, mp3);

    // Mirror to voiceovers/{voice_id}.mp3 so the user can swap back to this
    // generation later without re-running TTS.
    const perVoiceUrl = await putVoiceoverForVoice(id, voice_id, mp3);
    await recordVoiceoverGeneration(id, {
      voice_id,
      voice_name: voice_name || voice_id,
      url: perVoiceUrl,
      bytes: mp3.length,
      generated_at: new Date().toISOString(),
      model_id,
    });

    const meta = await getMeta(id);
    if (meta) {
      meta.voice_id = voice_id;
      if (voice_name) meta.voice_name = voice_name;
      meta.model_id = model_id;
      // voiceover.mp3 now contains THIS voice's bytes.
      meta.active_voice_id = voice_id;
      meta.updated_at = new Date().toISOString();
      await putMeta(meta);
    }

    // Emit voiceover.change so the puller picks it up + Gemini diffs the
    // new audio against the snapshot. Audio diff is multimodal (Gemini-2.5
    // accepts audio inlineData parts the same way as images).
    await appendChange(id, {
      type: 'voiceover.change',
      before: voSnap
        ? {
            voiceover_url: undefined,
            snapshot_url: voSnap.snapshot_url,
            voice_id: priorVoiceId,
          }
        : { voice_id: priorVoiceId },
      after: { voiceover_url: url, voice_id, voice_name, model_id },
      meta: {
        bytes: mp3.length,
        chunks: chunks.length,
        voice_settings: voice_settings ?? null,
      },
    });

    return Response.json({ ok: true, audio_url: url, bytes: mp3.length, chunks: chunks.length });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
