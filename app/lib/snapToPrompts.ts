// Snap the timeline to a canonical ordered list of narrations.
// For each target narration, walk through whisper words consuming tokens
// in order, recording start/end timestamps at the first/last matched word.
// This produces a timeline with exactly N segments, matching the 1:1
// VO_### → narration → prompt mapping the user pastes.

import type { Segment, PromptsMap } from './blob';

export type WhisperWord = { word: string; start: number; end: number };

const NORMALIZE_RE = /[^a-z0-9]+/gi;
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(NORMALIZE_RE, ' ').trim().split(/\s+/).filter(Boolean);
}

export function snapToPrompts(
  words: WhisperWord[],
  prompts: PromptsMap,
  existingEndCards: Segment[] = [],
): Segment[] {
  // Order segment IDs by their numeric suffix (VO_000, VO_001, …)
  const ids = Object.keys(prompts)
    .filter((k) => /^VO_\d+$/.test(k))
    .sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)));

  // Build a flat token stream from whisper words for fast matching
  const normWords = words.map((w) => ({
    tok: (w.word || '').toLowerCase().replace(NORMALIZE_RE, '').trim(),
    start: w.start,
    end: w.end,
  }));

  let cursor = 0;
  const segments: Segment[] = [];

  for (const id of ids) {
    const narration = (prompts[id]?.narration || '').trim();
    if (!narration) continue;
    const tokens = tokenize(narration);
    if (tokens.length === 0) continue;

    // Greedy sequential match: scan ahead from cursor looking for the first
    // occurrence of tokens[0]; then require ≥60% of subsequent tokens match
    // consecutively (some whisper word-boundary mismatches are tolerated).
    let bestStart = -1;
    let bestEnd = -1;
    const searchLimit = Math.min(normWords.length, cursor + tokens.length * 3 + 30);
    outer: for (let i = cursor; i < searchLimit; i++) {
      if (normWords[i].tok !== tokens[0]) continue;
      // Attempt to match the rest
      let matched = 1;
      let j = i + 1;
      for (let t = 1; t < tokens.length && j < normWords.length && j < i + tokens.length + 6; t++, j++) {
        // skip whisper words whose normalized token is empty (punctuation-only)
        while (j < normWords.length && !normWords[j].tok) j++;
        if (j < normWords.length && normWords[j].tok === tokens[t]) {
          matched++;
        }
      }
      const ratio = matched / tokens.length;
      if (ratio >= 0.6) {
        bestStart = i;
        bestEnd = Math.max(i, j - 1);
        break outer;
      }
    }

    if (bestStart < 0) {
      // Couldn't find in the local window — place it right after the cursor
      // using the previous segment's end as the new start.
      const prev = segments[segments.length - 1];
      const startT = prev?.end ?? (normWords[cursor]?.start ?? 0);
      segments.push({
        id,
        start: Number(startT.toFixed(3)),
        end: Number((startT + 0.5).toFixed(3)),
        duration: 0.5,
        narration,
        ken_burns: segments.length % 6 === 0 ? 'zoom_in' : segments.length % 2 === 0 ? 'pan_right' : 'push_in',
        kind: 'vo',
      });
      continue;
    }

    const startT = normWords[bestStart].start;
    const endT = normWords[bestEnd].end;
    segments.push({
      id,
      start: Number(startT.toFixed(3)),
      end: Number(endT.toFixed(3)),
      duration: Number((endT - startT).toFixed(3)),
      narration,
      ken_burns: segments.length % 6 === 0 ? 'zoom_in' : segments.length % 2 === 0 ? 'pan_right' : 'push_in',
      kind: 'vo',
    });
    cursor = bestEnd + 1;
  }

  // Enforce monotonic, non-overlapping boundaries — each seg.end = next.start
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i + 1].start < segments[i].end) {
      segments[i + 1].start = segments[i].end;
      segments[i + 1].duration = Number(
        (segments[i + 1].end - segments[i + 1].start).toFixed(3),
      );
    }
    segments[i].end = segments[i + 1].start;
    segments[i].duration = Number((segments[i].end - segments[i].start).toFixed(3));
  }

  // Preserve end-card segments (same rule as wm_align_by_content.py:178-186)
  const endCards = existingEndCards.filter((s) => s.id.startsWith('EC_'));
  endCards.sort((a, b) => a.start - b.start);
  segments.push(...endCards);
  return segments;
}
