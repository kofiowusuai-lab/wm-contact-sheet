// POST /api/global/mass-edit-history/suggest { query, limit? }
//
// Rank the global mass-edit prompt history by semantic similarity to the
// user's current input. Combines a cheap local overlap score (so the
// dropdown is instant on every keystroke) with an optional Gemini pass that
// re-orders the top candidates using a deeper understanding of intent.
// The caller can skip Gemini by setting { use_gemini: false }.

import { readJson } from '@/app/lib/blob';
import { geminiGenerate } from '@/app/lib/gemini';

export const runtime = 'nodejs';
export const maxDuration = 15;

const STORE_PATH = 'global/mass_edit_history.json';

type HistoryEntry = { text: string; used_at: string; use_count: number };
type HistoryDoc = { entries: HistoryEntry[]; updated_at: string };

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function localScore(queryTokens: string[], candTokens: string[]): number {
  if (queryTokens.length === 0 || candTokens.length === 0) return 0;
  const q = new Set(queryTokens);
  const c = new Set(candTokens);
  const inter = [...q].filter((t) => c.has(t)).length;
  const union = new Set([...q, ...c]).size;
  return inter / union;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const query = String(body?.query || '').trim();
    const limit = Math.max(1, Math.min(20, Number(body?.limit ?? 8) || 8));
    const useGemini = body?.use_gemini !== false;

    const doc = await readJson<HistoryDoc>(STORE_PATH);
    const entries = doc?.entries ?? [];
    if (entries.length === 0) return Response.json({ entries: [] });

    // Local ranking: overlap + recency/count prior. Runs even when the query
    // is empty so we still surface the most-used prompts in that case.
    const queryTokens = tokens(query);
    const ranked = entries
      .map((e) => {
        const candTokens = tokens(e.text);
        const overlap = queryTokens.length ? localScore(queryTokens, candTokens) : 0;
        const prior = Math.log1p(e.use_count || 1) * 0.05;
        const recency = Math.min(1, (Date.now() - new Date(e.used_at).getTime()) / (1000 * 60 * 60 * 24 * 30));
        return {
          entry: e,
          score: overlap + prior - recency * 0.02,
        };
      })
      .sort((a, b) => b.score - a.score);

    // No query and Gemini off: return recency-sorted head.
    if (!query || !useGemini || !process.env.GEMINI_API_KEY) {
      return Response.json({
        entries: ranked.slice(0, limit).map((r) => r.entry),
        gemini_used: false,
      });
    }

    // Take top N local candidates, let Gemini re-rank them. Keeping the
    // candidate set small keeps the call fast and cheap.
    const candidateCount = Math.min(entries.length, Math.max(limit * 2, 12));
    const candidates = ranked.slice(0, candidateCount).map((r, i) => ({ i, text: r.entry.text }));

    const system =
      'You rank prior image-editing prompts by how well each one matches a new query the user is typing. ' +
      'Score each candidate 0-100 based on how likely the user wants that exact kind of edit. ' +
      'Return ONLY a JSON array of {i, score} objects, no prose, no markdown fences.';
    const userPrompt = [
      `USER QUERY: ${query}`,
      '',
      'CANDIDATES (JSON):',
      JSON.stringify(candidates),
      '',
      'Rank every candidate.',
    ].join('\n');

    let parsed: Array<{ i: number; score: number }> = [];
    try {
      const raw = await geminiGenerate(userPrompt, {
        system,
        json: true,
        temperature: 0.1,
        maxOutputTokens: 800,
      });
      const stripped = raw.replace(/^```json\s*|\s*```$/g, '').trim();
      const data = JSON.parse(stripped);
      if (Array.isArray(data)) parsed = data;
    } catch {
      // Fall back to local ranking silently — we still want to serve results.
    }

    const geminiScoreByIdx = new Map<number, number>();
    for (const row of parsed) {
      if (typeof row?.i === 'number' && typeof row?.score === 'number') {
        geminiScoreByIdx.set(row.i, row.score);
      }
    }

    const final = candidates
      .map((c) => ({
        entry: ranked[c.i].entry,
        score: geminiScoreByIdx.get(c.i) ?? ranked[c.i].score * 100,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.entry);

    return Response.json({ entries: final, gemini_used: parsed.length > 0 });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
