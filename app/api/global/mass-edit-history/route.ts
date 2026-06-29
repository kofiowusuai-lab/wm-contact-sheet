// Global mass-edit prompt history. Lives at global/mass_edit_history.json
// in Supabase so it's shared across every project. Every time the user runs
// "Mass edit all frames" with a new instruction we record it here; typing
// into the mass-edit input shows suggestions from this log.
//
//   GET  -> { entries: [{ text, used_at, use_count }], updated_at }
//   POST { text }  -> de-dup + bump use_count + move to top, returns latest doc

import { readJson, writeJson } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

const STORE_PATH = 'global/mass_edit_history.json';
const MAX_ENTRIES = 100;

export type HistoryEntry = {
  text: string;
  used_at: string;
  use_count: number;
};
export type HistoryDoc = {
  entries: HistoryEntry[];
  updated_at: string;
};

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

async function getDoc(): Promise<HistoryDoc> {
  const doc = await readJson<HistoryDoc>(STORE_PATH);
  if (doc && Array.isArray(doc.entries)) return doc;
  // First call seeds the history with one known-good prompt so the dropdown
  // has something useful to show on a brand-new install.
  const seed: HistoryDoc = {
    entries: [
      {
        text:
          'Zoom out slightly for a wider angle, showing more of the environment. Keep the character, wardrobe, composition, lighting, and background identical — only the framing changes.',
        used_at: new Date().toISOString(),
        use_count: 1,
      },
    ],
    updated_at: new Date().toISOString(),
  };
  await writeJson(STORE_PATH, seed);
  return seed;
}

export async function GET() {
  try {
    const doc = await getDoc();
    return Response.json(doc);
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const raw = String(body?.text || '');
    const text = normalize(raw);
    if (!text) return Response.json({ error: 'text required' }, { status: 400 });
    if (text.length > 1200) {
      return Response.json({ error: 'text too long' }, { status: 400 });
    }
    const doc = await getDoc();
    const now = new Date().toISOString();
    // Case-insensitive dedup: if an equivalent entry exists, bump it and move
    // it to the head of the list rather than creating a near-duplicate row.
    const key = text.toLowerCase();
    const existing = doc.entries.findIndex(
      (e) => normalize(e.text).toLowerCase() === key,
    );
    let entry: HistoryEntry;
    if (existing >= 0) {
      entry = {
        text: doc.entries[existing].text,
        used_at: now,
        use_count: (doc.entries[existing].use_count || 0) + 1,
      };
      doc.entries.splice(existing, 1);
    } else {
      entry = { text, used_at: now, use_count: 1 };
    }
    doc.entries.unshift(entry);
    if (doc.entries.length > MAX_ENTRIES) {
      doc.entries.length = MAX_ENTRIES;
    }
    doc.updated_at = now;
    await writeJson(STORE_PATH, doc);
    return Response.json(doc);
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
