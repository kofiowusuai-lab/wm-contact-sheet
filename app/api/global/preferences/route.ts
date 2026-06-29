// Global creative preferences — craft/aesthetic rules that apply across
// every project. Populated by the promote endpoint (called automatically
// after each per-project preferences refresh); read back by /api/generate
// so the model gets a consistent taste profile regardless of which project
// the user is working on.
//
//   GET  -> { rules: [...], updated_at }
//   DELETE -> clears the doc (used if the user wants a clean slate)

import { readJson, writeJson } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

const STORE_PATH = 'global/creative_preferences.json';

export type GlobalRule = {
  topic?: string;
  rule: string;
  confidence: number;
  sources: { project_id: string; first_seen: string }[];
  promoted_at: string;
  portability_note?: string;
};

export type GlobalPrefsDoc = {
  rules: GlobalRule[];
  updated_at: string;
};

export async function GET() {
  try {
    const doc = (await readJson<GlobalPrefsDoc>(STORE_PATH)) ?? {
      rules: [],
      updated_at: new Date(0).toISOString(),
    };
    return Response.json(doc, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await writeJson(STORE_PATH, { rules: [], updated_at: new Date().toISOString() });
    return Response.json({ ok: true, cleared: true });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
