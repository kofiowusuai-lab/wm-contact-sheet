// POST /api/ai/rewrite-narration
//
// Takes a Whisper transcript from an uploaded reference clip and returns a
// fresh restatement of the same information in the user's voice. The goal
// is re-delivery, not paraphrase-disguise: preserve facts, structure,
// examples, and pacing so the audience gets the same value, but restate
// every sentence so the output isn't the source. Downstream TTS voices the
// rewritten text.
//
// Guardrails (enforced by this route, not the prompt):
//   - Minimum length:    rewritten.words >= 0.5 * source.words (otherwise
//                        it's a summary, not a re-delivery).
//   - Max overlap:       4-gram Jaccard similarity with the source must be
//                        <= 0.3. Higher → one retry with a stricter
//                        phrasing nudge, then 422.
//   - Lyric / dialogue:  heuristics on line length + repetition flag song
//                        choruses / script dialogue and 422. This route
//                        only re-delivers informational content.
//
// Request:  { transcript: string, style_hint?: string, approx_word_count?: number }
// Response: { rewritten_text: string, overlap: number, words: number }
// Errors:   422 with { error, kind: 'overlap' | 'lyric' | 'too_short' | 'empty' }

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_MODEL = 'gemini-2.5-flash';

const OVERLAP_LIMIT = 0.3;   // 4-gram Jaccard
const MIN_LENGTH_FRAC = 0.5; // rewritten / source word count floor

async function gemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
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
    if (!out) throw new Error(`gemini empty response: ${text.slice(0, 200)}`);
    return out;
  }
  throw lastErr ?? new Error('gemini exhausted retries');
}

function buildPrompt(transcript: string, styleHint: string, targetWords: number, stricter: boolean): string {
  const style = styleHint
    || 'direct, confident, no-fluff, matter-of-fact — short sentences, active voice, no em-dashes, no filler words';
  const stricterRule = stricter
    ? '\n\nEXTRA RULE: the previous attempt was too close to the source. Restructure every sentence from scratch. Change the order of points where it does not break the logic. Swap near-identical phrases for different constructions. You MUST NOT reuse any four-word sequence from the source.'
    : '';
  return `You are restating the information from a reference clip in the user's own voice so they can re-deliver it in their own video. Your job is a fresh retelling, not a paraphrase. Every sentence must be rewritten from scratch.

PRESERVE:
- Every factual claim and insight from the source.
- The order and structure of the argument (hook, body, payoff).
- Examples and specific numbers / references that make the point concrete.
- Approximate density of ideas per minute so the audience gets the same value.

DO NOT:
- Copy any phrasing from the source. Assume strict plagiarism detection.
- Add new claims or facts that are not in the source.
- Output markdown, bullet points, headings, stage directions, or meta commentary.
- Use em-dashes.

TONE: ${style}.

TARGET LENGTH: around ${targetWords} words (±15%).

SOURCE TRANSCRIPT:
"""
${transcript}
"""
${stricterRule}

Return ONLY the rewritten narration as plain text. Paragraph breaks are allowed (two newlines). No other formatting.`;
}

// --- Sanitiser ------------------------------------------------------------

function sanitise(out: string): string {
  return String(out || '')
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/i, '')
    .replace(/^\s*[*\-•]\s+/gm, '')      // strip leading bullet markers
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // strip bold / italic markdown
    .replace(/—/g, ', ')                 // swap em-dashes for commas
    .replace(/\r\n/g, '\n')
    .trim();
}

// --- Overlap + heuristics -------------------------------------------------

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ']/g, ' ').split(/\s+/).filter(Boolean);
}

function fourGrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 < tokens.length; i++) {
    out.add(tokens.slice(i, i + 4).join(' '));
  }
  return out;
}

function jaccard4Gram(a: string, b: string): number {
  const ga = fourGrams(tokenize(a));
  const gb = fourGrams(tokenize(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const union = ga.size + gb.size - shared;
  return union === 0 ? 0 : shared / union;
}

// Flag obvious lyric / dialogue content so this route doesn't help launder
// copyrighted creative work. Heuristic, not exhaustive — caller should
// never rely on this for hard copyright enforcement.
function looksLikeCreativeWork(transcript: string): boolean {
  const lines = transcript
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 6) return false;

  // Song lyrics / poems — short lines in quick succession + strong repetition.
  const shortLines = lines.filter((l) => l.split(/\s+/).length <= 10).length;
  if (shortLines / lines.length > 0.7) {
    const counts = new Map<string, number>();
    for (const l of lines) {
      const key = l.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const repeatedBlocks = [...counts.values()].filter((n) => n >= 3).length;
    if (repeatedBlocks >= 1) return true;
  }

  // Stage dialogue — recurring NAME: prefix on most lines.
  const namePrefixed = lines.filter((l) => /^[A-Z][A-Z '.-]{1,30}:\s/.test(l)).length;
  if (namePrefixed / lines.length > 0.5) return true;

  return false;
}

// --- Route handler --------------------------------------------------------

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const transcript = String(body?.transcript || '').trim();
    if (!transcript) {
      return Response.json({ error: 'transcript required', kind: 'empty' }, { status: 400 });
    }
    const styleHint = String(body?.style_hint || '').trim();
    const sourceWords = transcript.split(/\s+/).filter(Boolean).length;
    const approxTarget =
      Number.isFinite(body?.approx_word_count) && body.approx_word_count > 0
        ? Math.floor(body.approx_word_count)
        : sourceWords;

    if (looksLikeCreativeWork(transcript)) {
      return Response.json(
        {
          error:
            'Source looks like lyrics, poetry, or stage dialogue. This endpoint only re-delivers informational content. Use the original audio instead or pick a different source.',
          kind: 'lyric',
        },
        { status: 422 },
      );
    }

    // First attempt.
    let raw = await gemini(buildPrompt(transcript, styleHint, approxTarget, false));
    let rewritten = sanitise(raw);
    let overlap = jaccard4Gram(rewritten, transcript);
    let rewrittenWords = rewritten.split(/\s+/).filter(Boolean).length;

    // Retry once with a stricter nudge if the rewrite is too close.
    if (overlap > OVERLAP_LIMIT) {
      raw = await gemini(buildPrompt(transcript, styleHint, approxTarget, true));
      const second = sanitise(raw);
      const secondOverlap = jaccard4Gram(second, transcript);
      if (secondOverlap < overlap) {
        rewritten = second;
        overlap = secondOverlap;
        rewrittenWords = rewritten.split(/\s+/).filter(Boolean).length;
      }
    }

    if (overlap > OVERLAP_LIMIT) {
      return Response.json(
        {
          error: `Rewrite stayed too close to the source (4-gram overlap ${(overlap * 100).toFixed(0)}% > ${OVERLAP_LIMIT * 100}%). Try a different source or use the original audio instead.`,
          kind: 'overlap',
          overlap,
        },
        { status: 422 },
      );
    }

    if (rewrittenWords < sourceWords * MIN_LENGTH_FRAC) {
      return Response.json(
        {
          error: `Rewrite is too short (${rewrittenWords} words vs. ${sourceWords} source). This looks like a summary, not a re-delivery.`,
          kind: 'too_short',
          words: rewrittenWords,
        },
        { status: 422 },
      );
    }

    return Response.json({
      rewritten_text: rewritten,
      overlap,
      words: rewrittenWords,
      source_words: sourceWords,
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
