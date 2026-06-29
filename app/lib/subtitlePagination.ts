// Subtitle pagination — keep parity with the Python implementation in
// scripts/render_from_supabase.py::_paginate_segment. Both are exercised by
// app/lib/__fixtures__/pagination_cases.json. Any algorithm change here MUST
// be mirrored in Python; the fixture parity test will fail otherwise.
//
// Greedy word-fill at maxCharsPerLine. After every maxLines lines, start a
// new page. Single words longer than the cap get their own line — never
// split mid-word. Page timing comes from word timestamps when available, or
// from a character-weighted divide of the segment duration when not.

export type WordTiming = { word: string; start: number; end: number };

export type Page = {
  lines: string[];
  start: number;
  end: number;
};

export type PaginationOptions = {
  maxLines: number;
  maxCharsPerLine: number;
  /** Pages shorter than this merge with the previous page. */
  minPageDurationSec?: number;
};

const DEFAULT_MIN_PAGE_DUR = 0.6;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Greedy word-fill into lines of at most `maxCharsPerLine`. Single words
 *  longer than the cap get their own line. */
function wrapToLines(words: string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) {
      cur = w;
      continue;
    }
    if (cur.length + 1 + w.length <= maxCharsPerLine) {
      cur = cur + ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** Group `lines` into pages of `maxLines` each. */
function chunkPages(lines: string[], maxLines: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    out.push(lines.slice(i, i + maxLines));
  }
  return out;
}

/** Map words → page index using the SAME wrap algorithm. */
function wordsByPage(
  words: string[],
  maxCharsPerLine: number,
  maxLines: number,
): number[] {
  // wordIdx → pageIdx
  const out: number[] = new Array(words.length);
  let line = '';
  let lineCount = 0;
  let pageIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!line.length) {
      line = w;
    } else if (line.length + 1 + w.length <= maxCharsPerLine) {
      line = line + ' ' + w;
    } else {
      // Line full → finalize this line, start new one with `w`.
      lineCount++;
      if (lineCount >= maxLines) {
        pageIdx++;
        lineCount = 0;
      }
      line = w;
    }
    out[i] = pageIdx;
  }
  return out;
}

/** Merge runt pages (shorter than minPageDurationSec) into the previous
 *  page. If the first page is a runt, merge it forward into page 1. */
function mergeRunts(pages: Page[], minDur: number): Page[] {
  if (pages.length <= 1) return pages;
  const out: Page[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const dur = p.end - p.start;
    if (dur >= minDur || out.length === 0) {
      // First page: keep, even if short — handle forward-merge below.
      out.push({ lines: [...p.lines], start: p.start, end: p.end });
    } else {
      const prev = out[out.length - 1];
      prev.lines = prev.lines.concat(p.lines);
      prev.end = p.end;
    }
  }
  // If the first page is still a runt and there's a next, merge forward.
  if (out.length >= 2 && out[0].end - out[0].start < minDur) {
    const head = out[0];
    const next = out[1];
    next.lines = head.lines.concat(next.lines);
    next.start = head.start;
    out.shift();
  }
  return out;
}

export function paginate(
  narration: string,
  words: WordTiming[] | null,
  segStart: number,
  segEnd: number,
  opts: PaginationOptions,
): Page[] {
  const text = (narration || '').trim();
  if (!text) return [];

  const maxLines = clamp(Math.round(opts.maxLines || 2), 1, 4);
  const maxCharsPerLine = clamp(Math.round(opts.maxCharsPerLine || 38), 16, 80);
  const minPageDur = opts.minPageDurationSec ?? DEFAULT_MIN_PAGE_DUR;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Build the line layout once so word→page mapping uses identical wrap.
  const flatLines = wrapToLines(tokens, maxCharsPerLine);
  const pageLines = chunkPages(flatLines, maxLines);
  if (pageLines.length === 0) return [];

  // Single-page case: cover the entire segment, no timing math needed.
  if (pageLines.length === 1) {
    return [{ lines: pageLines[0], start: segStart, end: segEnd }];
  }

  // Word→page mapping (same wrap algorithm) for accurate timing.
  const wordToPage = wordsByPage(tokens, maxCharsPerLine, maxLines);
  const pageStart: number[] = new Array(pageLines.length).fill(NaN);
  const pageEnd: number[] = new Array(pageLines.length).fill(NaN);

  // Build first/last word index per page.
  const firstWordOfPage: number[] = new Array(pageLines.length).fill(-1);
  const lastWordOfPage: number[] = new Array(pageLines.length).fill(-1);
  for (let i = 0; i < tokens.length; i++) {
    const p = wordToPage[i];
    if (firstWordOfPage[p] === -1) firstWordOfPage[p] = i;
    lastWordOfPage[p] = i;
  }

  const haveWords = Array.isArray(words) && words.length > 0;

  if (haveWords && words!.length === tokens.length) {
    // Direct 1:1 mapping — best case.
    for (let p = 0; p < pageLines.length; p++) {
      const fw = words![firstWordOfPage[p]];
      const lw = words![lastWordOfPage[p]];
      pageStart[p] = clamp(fw.start, segStart, segEnd);
      pageEnd[p] = clamp(lw.end, segStart, segEnd);
    }
  } else if (haveWords) {
    // Token count mismatch (TTS sometimes splits/joins differently). Fall
    // back to time-proportional within the segment using word coverage as a
    // hint: stretch each page proportionally to its character share.
    const totalChars = tokens.reduce((s, w) => s + w.length, 0) + tokens.length - 1;
    let cursor = segStart;
    for (let p = 0; p < pageLines.length; p++) {
      const pageWords = tokens.slice(firstWordOfPage[p], lastWordOfPage[p] + 1);
      const pageChars = pageWords.reduce((s, w) => s + w.length, 0) + Math.max(pageWords.length - 1, 0);
      const dur = ((segEnd - segStart) * pageChars) / Math.max(totalChars, 1);
      pageStart[p] = cursor;
      pageEnd[p] = p === pageLines.length - 1 ? segEnd : cursor + dur;
      cursor = pageEnd[p];
    }
  } else {
    // No word timings at all — even-divide by character weight.
    const totalChars = tokens.reduce((s, w) => s + w.length, 0) + Math.max(tokens.length - 1, 0);
    let cursor = segStart;
    for (let p = 0; p < pageLines.length; p++) {
      const pageWords = tokens.slice(firstWordOfPage[p], lastWordOfPage[p] + 1);
      const pageChars = pageWords.reduce((s, w) => s + w.length, 0) + Math.max(pageWords.length - 1, 0);
      const dur = ((segEnd - segStart) * pageChars) / Math.max(totalChars, 1);
      pageStart[p] = cursor;
      pageEnd[p] = p === pageLines.length - 1 ? segEnd : cursor + dur;
      cursor = pageEnd[p];
    }
  }

  const pages: Page[] = pageLines.map((lines, i) => ({
    lines,
    start: pageStart[i],
    end: pageEnd[i],
  }));

  return mergeRunts(pages, minPageDur);
}

/** Pick the page index active at `t` (segment-clock seconds), or -1 if none. */
export function activePageIndex(pages: Page[], t: number): number {
  for (let i = 0; i < pages.length; i++) {
    if (t >= pages[i].start && t < pages[i].end) return i;
  }
  if (pages.length && t >= pages[pages.length - 1].end) return pages.length - 1;
  return -1;
}
