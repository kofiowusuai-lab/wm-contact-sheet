// Parse the mass-import prompt format:
//
//   VO_045 — "The bank paid you to build decks."
//   Wardrobe: Dark hoodie — early career, pre-transformation
//   "Anime-style young man in a dark hoodie..."
//
// Returns one entry per VO_### block: { id, narration, wardrobe, prompt }.

export type ParsedBlock = {
  id: string;
  narration: string;
  wardrobe: string;
  prompt: string;
  /** Optional location id parsed from a "Location: foo_bar" line. Empty /
   *  "none" => no location binding. */
  location?: string;
};

const HEADER_RE = /^VO_(\d+)\s*[—\-]/m;

export function parsePrompts(text: string): ParsedBlock[] {
  const normalized = text.replace(/\r\n/g, '\n');
  // Split so that each block still starts with its VO_### header
  const parts = normalized.split(/(?=^VO_\d+\s*[—\-])/m);
  const out: ParsedBlock[] = [];
  for (const part of parts) {
    const header = HEADER_RE.exec(part);
    if (!header) continue;
    const num = header[1].padStart(3, '0');
    const id = `VO_${num}`;

    // Collect all quoted strings (supports " or smart quotes)
    const quoted = [...part.matchAll(/["“”]([^"“”]+)["“”]/g)].map((m) => m[1].trim());
    const narration = quoted[0] ?? '';
    const prompt = quoted.reduce((longest, q) => (q.length > longest.length ? q : longest), '');

    const wardMatch = /^Wardrobe:\s*(.+)$/m.exec(part);
    const wardrobe = wardMatch ? wardMatch[1].trim() : '';

    const locMatch = /^Location:\s*(.+)$/m.exec(part);
    const rawLoc = locMatch ? locMatch[1].trim() : '';
    // Treat "none" / "NEW_*" / empty as "no binding" — the operator needs
    // to hand-pick a location for those, or the beat has no fixed env.
    const location =
      !rawLoc || /^none$/i.test(rawLoc) || /^new_/i.test(rawLoc) ? '' : rawLoc;

    if (!prompt) continue;
    out.push({ id, narration, wardrobe, prompt, location });
  }
  return out;
}
