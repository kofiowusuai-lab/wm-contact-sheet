// TS port of scripts/wm_align_by_content.py::segment_words. Groups Whisper
// words into caption-length segments. Splits on phrase-level punctuation
// (.!?,;:—–) AND silence pauses >= pauseThresh, then merges any runs shorter
// than 0.6s back into the previous segment so we don't produce strobey
// 2-word flashes. Matches scripts/wm_server.py::_segment_words so browser
// and tunnel resegmentation land on the same boundaries.

import type { Segment } from './blob';

export type Word = { word: string; start: number; end: number };

// Abbreviations that end in "." but shouldn't trigger a phrase split.
// Compared case-insensitively against the last 4-ish chars of a word.
const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'mr.', 'mrs.', 'ms.', 'dr.', 'jr.', 'sr.', 'vs.',
  'st.', 'prof.', 'fig.', 'no.', 'inc.', 'ltd.', 'co.', 'lt.', 'sgt.',
  'capt.', 'gen.', 'hon.', 'rev.', 'gov.', 'pres.', 'sen.', 'rep.', 'u.s.',
  'u.k.', 'a.m.', 'p.m.',
]);

function endsPhrase(raw: string): boolean {
  const text = (raw || '').trim();
  if (!text) return false;
  // Not a phrase ender at all.
  if (!/[.,!?;:—–]$/.test(text)) return false;
  // Numeric decimal like "4.5" or "4.5%," — only a split if the LAST char
  // is a phrase-closing punct (ends in "," "%." etc.). A trailing "." on
  // "4.5" never lands here because "5" isn't in the charset. But "4.5,"
  // SHOULD still split. The regex above already picked the trailing char
  // so we're good. Only guard against decimals that present as "4." etc.
  if (/\d\.$/.test(text) && !/[,;:]\s*$/.test(text)) {
    // "4." — treat as not-a-split so version numbers / numbered lists
    // don't explode the segmentation mid-stream.
    return false;
  }
  // Common abbreviations ending in "."
  const lower = text.toLowerCase();
  if (text.endsWith('.')) {
    for (const abbr of ABBREVIATIONS) {
      if (lower.endsWith(abbr)) return false;
    }
  }
  return true;
}

export function segmentWords(
  words: Word[],
  pauseThresh = 0.35,
  mergeFloor = 0.3,
): Array<{ start: number; end: number; text: string }> {
  const segs: Array<{ start: number; end: number; text: string }> = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const text = (w.word || '').trim();
    const endsPhraseHere = endsPhrase(text);
    const next = words[i + 1];
    const pauseNext = next ? next.start - w.end > pauseThresh : false;
    if (endsPhraseHere || pauseNext || i === words.length - 1) {
      if (cur.length) {
        segs.push({
          start: cur[0].start,
          end: cur[cur.length - 1].end,
          text: cur.map((x) => (x.word || '').trim()).join(' ').trim(),
        });
        cur = [];
      }
    }
  }
  // Merge runs shorter than mergeFloor into the previous segment so
  // single-word micro-splits like "a," / "of," don't strobe. Keep the
  // default low (0.3s) so two-word beats like "Dividend stocks." stay
  // on-screen long enough but don't collapse into their neighbours.
  const merged: Array<{ start: number; end: number; text: string }> = [];
  for (const s of segs) {
    if (merged.length && s.end - s.start < mergeFloor) {
      const last = merged[merged.length - 1];
      last.end = s.end;
      last.text += ' ' + s.text;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

export function numberSegments(
  segs: Array<{ start: number; end: number; text: string }>,
  existingEndCards: Segment[] = [],
): Segment[] {
  const out: Segment[] = segs.map((s, i) => ({
    id: `VO_${String(i).padStart(3, '0')}`,
    start: Number(s.start.toFixed(3)),
    end: Number(s.end.toFixed(3)),
    duration: Number((s.end - s.start).toFixed(3)),
    narration: s.text,
    ken_burns: i % 6 === 0 ? 'zoom_in' : i % 2 === 0 ? 'pan_right' : 'push_in',
    kind: 'vo',
  }));

  // Preserve end-card segments (same rule as wm_align_by_content.py:178-186)
  const endCards = existingEndCards.filter((s) => s.id.startsWith('EC_'));
  if (endCards.length) {
    endCards.sort((a, b) => a.start - b.start);
    out.push(...endCards);
  }
  return out;
}
