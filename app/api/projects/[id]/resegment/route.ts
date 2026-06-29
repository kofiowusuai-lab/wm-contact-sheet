// POST /api/projects/{id}/resegment  { pause_thresh?: number }
//
// Re-chunk an existing project's timeline.json using the dense
// word-level splitter (phrase punctuation + silence pauses). When a
// script.txt exists we transplant its punctuation back onto the
// Whisper words first — Whisper regularly drops commas / em-dashes
// on clean TTS audio, which collapses what should be 11 beats into 1
// long static frame. Transplant-then-split reproduces what the user
// originally wrote.
//
// The audio + words.json stay untouched — only segment boundaries
// change. prompts.json is reset to {} because VO_### ids move, so the
// user has to re-run autofill + re-generate frames.
//
// Response: { ok, count, vo_count, ec_count, transplanted_punct }

import {
  getWords,
  getScript,
  getTimeline,
  putTimeline,
  putPrompts,
} from '@/app/lib/blob';
import { segmentWords, numberSegments } from '@/app/lib/segment';
import type { Word } from '@/app/lib/segment';

export const runtime = 'nodejs';
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

// Tokenise the script into { base, suffix } pairs. `base` is the lowercased
// alnum skeleton (matches what Whisper emits), `suffix` is the trailing
// phrase punctuation ("," ";" "—" etc.) we want to transplant back onto
// the timed word stream.
//
// Handles the " word — word " pattern correctly: standalone em-dashes
// (and other phrase-only tokens) aren't their own entries; their suffix
// attaches to the PREVIOUS word.
function scriptTokens(script: string): Array<{ base: string; suffix: string }> {
  if (!script) return [];
  // Strip @NAME: tags + bracketed stage directions so they don't pollute
  // the token stream.
  const cleaned = script
    .replace(/\r\n/g, '\n')
    .replace(/^@[A-Z][A-Z0-9_-]*:\s*/gm, '')
    .replace(/\[[^\]]+\]/g, ' ');
  const out: Array<{ base: string; suffix: string }> = [];
  const rawTokens = cleaned.split(/\s+/).filter(Boolean);
  const PHRASE_CHARS = /[.,!?;:—–]/;
  const PHRASE_ONLY = /^[.,!?;:—–]+$/;

  for (const tok of rawTokens) {
    if (PHRASE_ONLY.test(tok)) {
      // Standalone punctuation token (e.g. "—"). Append to the previous
      // word's suffix so the split point lands at the right place.
      if (out.length > 0) out[out.length - 1].suffix += tok;
      continue;
    }
    const m = /^(.*?)([.,!?;:—–]+)?$/u.exec(tok);
    const core = (m?.[1] ?? tok).toLowerCase().replace(/[^a-z0-9']/g, '');
    const suffix = m?.[2] ?? '';
    if (!core && !suffix) continue;
    if (core) out.push({ base: core, suffix });
    else if (suffix && out.length > 0) out[out.length - 1].suffix += suffix;
  }
  // Collapse empty-suffix noise in case we accidentally stacked nothing.
  for (const t of out) {
    if (t.suffix && !PHRASE_CHARS.test(t.suffix)) t.suffix = '';
  }
  return out;
}

// Walk script tokens + Whisper words in parallel. Where the script's token
// has trailing phrase punctuation, attach it to the matching Whisper
// word's `word` field so segmentWords sees the split point downstream.
// Tolerates small drift (one stream skips a word) via a short look-ahead.
function transplantPunctuation(
  words: Word[],
  script: string,
): { enriched: Word[]; transplanted: number } {
  const tokens = scriptTokens(script);
  if (tokens.length === 0) return { enriched: words, transplanted: 0 };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
  const enriched: Word[] = words.map((w) => ({ ...w }));
  let ti = 0;
  let transplanted = 0;

  for (let wi = 0; wi < enriched.length; wi++) {
    const wbase = norm(enriched[wi].word || '');
    if (!wbase) continue;

    // Find the nearest script token ahead (±3 window) that matches.
    let matched = -1;
    for (let j = Math.max(0, ti - 1); j < Math.min(tokens.length, ti + 4); j++) {
      if (tokens[j].base === wbase) { matched = j; break; }
    }
    if (matched < 0) continue;
    ti = matched + 1;

    // Attach script's trailing punctuation to this Whisper word. If the
    // Whisper word already ends with phrase punct, leave it alone.
    const existing = (enriched[wi].word || '').trim();
    if (/[.,!?;:—–]$/.test(existing)) continue;
    const suffix = tokens[matched].suffix;
    if (!suffix) continue;
    enriched[wi].word = existing + suffix;
    transplanted++;
  }
  return { enriched, transplanted };
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const pauseThresh = Number.isFinite(body?.pause_thresh)
      ? Math.max(0.15, Math.min(1.2, Number(body.pause_thresh)))
      : 0.35;

    const wdoc = await getWords(id);
    if (!wdoc) {
      return Response.json(
        { error: 'no words.json — run /transcribe first' },
        { status: 400 },
      );
    }
    const words = wdoc.words || [];
    if (words.length === 0) {
      return Response.json(
        { error: 'words.json has no words' },
        { status: 400 },
      );
    }

    // Preserve any EC_* end-card segments the user already set up.
    const existing = (await getTimeline(id)) ?? [];

    // Re-apply the original script's phrase punctuation where Whisper
    // dropped it. Falls through gracefully when there's no script.txt.
    const script = (await getScript(id)) || '';
    const { enriched, transplanted } = transplantPunctuation(words, script);

    const segs = segmentWords(enriched, pauseThresh);
    const numbered = numberSegments(segs, existing);
    await putTimeline(id, numbered);

    // VO_### ids moved, so old prompt entries no longer line up. Clear
    // so the UI + autofill re-compute against the new boundaries.
    await putPrompts(id, {});

    return Response.json({
      ok: true,
      count: numbered.length,
      vo_count: numbered.filter((s) => s.kind === 'vo').length,
      ec_count: numbered.filter((s) => s.kind === 'end_card').length,
      pause_thresh: pauseThresh,
      transplanted_punct: transplanted,
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
