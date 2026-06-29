// Script-side parser for the multi-voice pipeline. Splits a prose script
// into "speaker turns" — contiguous runs of lines spoken by the same
// voice — using a simple convention:
//
//   Plain paragraphs                → narrator
//   Lines starting with `@NAME:`    → dialogue spoken by NAME
//
// Example:
//
//   Riley sat at the island. The coffee was cold.
//
//   @NIA: "If you tell him, you lose him."
//   @RILEY: "I know what it means."
//   @NIA: "Then don't."
//
//   She left. Riley stared at the door.
//
// …parses into 5 turns: narrator, NIA, RILEY, NIA, narrator.
//
// The parser is deliberately permissive: capitalisation of the NAME is
// normalised to uppercase, whitespace around the colon is tolerated,
// smart quotes inside dialogue are preserved, and lines that look like
// "@something" but aren't speaker tags (e.g. "@everyone listen") fall
// through as narrator. A line IS a speaker tag only when it matches:
//
//   ^@<word-chars>:\s.+
//
// The tail of the line (after the colon) is the spoken text. Multiple
// consecutive lines with the same speaker are merged into one turn so
// ElevenLabs isn't billed per line.

export type SpeakerTurn = {
  /** Uppercase character name, or empty string for narrator. */
  speaker: string;
  /** The spoken text for this turn — already joined across merged
   *  consecutive same-speaker lines, with single-newline separators
   *  preserved so TTS inherits the natural pacing. */
  text: string;
};

const SPEAKER_TAG_RE = /^@([A-Za-z][A-Za-z0-9_-]*)\s*:\s+(.+)$/;

export function parseSpeakerTags(script: string): SpeakerTurn[] {
  const lines = script.replace(/\r\n/g, '\n').split('\n');
  const turns: SpeakerTurn[] = [];
  // Buffer the current run of lines sharing a speaker, flush when the
  // speaker changes.
  let curSpeaker = '';
  let curBuf: string[] = [];

  const flush = () => {
    const text = curBuf.join('\n').trim();
    if (text) turns.push({ speaker: curSpeaker, text });
    curBuf = [];
  };

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) {
      // Preserve paragraph breaks within the current speaker run so
      // the TTS call inherits natural pauses. Only flush on a blank
      // line if it's about to change speakers — we defer that decision
      // to the next non-blank line.
      curBuf.push('');
      continue;
    }
    const m = SPEAKER_TAG_RE.exec(trimmed);
    if (m) {
      const nextSpeaker = m[1].toUpperCase();
      const lineText = m[2].trim();
      if (nextSpeaker !== curSpeaker) {
        flush();
        curSpeaker = nextSpeaker;
      }
      curBuf.push(lineText);
    } else {
      // Narrator line.
      if (curSpeaker !== '') {
        flush();
        curSpeaker = '';
      }
      curBuf.push(trimmed);
    }
  }
  flush();
  return turns;
}

/** Unique speaker names (uppercase) used in a script. Excludes the
 *  empty-string narrator slot. */
export function speakersUsed(script: string): string[] {
  const seen = new Set<string>();
  for (const t of parseSpeakerTags(script)) {
    if (t.speaker) seen.add(t.speaker);
  }
  return Array.from(seen).sort();
}

/** Find character slugs referenced in a free-form text (narration line,
 *  image prompt body, etc.). Used to pick the right character reference
 *  image(s) when generating a frame.
 *
 *  Matches in three ways:
 *    1. `@NAME:` dialogue tags (the primary, unambiguous form).
 *    2. `@NAME` inline mentions without a colon (e.g. "behind @SARAH").
 *    3. Plain-text whole-word mentions of a known slug, case-insensitive
 *       (e.g. "Sarah" → `SARAH`) — only when `knownSlugs` is provided,
 *       otherwise we can't tell "Sarah" from a random capitalised word.
 *
 *  Returns an uppercased set. */
export function extractCharacterMentions(
  text: string,
  knownSlugs: readonly string[] = [],
): Set<string> {
  const found = new Set<string>();
  if (!text) return found;

  // @NAME: dialogue tag + @NAME inline mention. Matches `@Sarah` and
  // `@SARAH:` alike.
  const atRe = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = atRe.exec(text)) !== null) {
    found.add(m[1].toUpperCase());
  }

  // Plain-text mentions, whole-word, case-insensitive. Only slugs we
  // already know about — otherwise "Dark suit" would tag a `DARK`
  // character that doesn't exist.
  for (const slug of knownSlugs) {
    if (!slug) continue;
    const safe = slug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const wholeWord = new RegExp(`\\b${safe}\\b`, 'i');
    if (wholeWord.test(text)) found.add(slug.toUpperCase());
  }

  return found;
}
