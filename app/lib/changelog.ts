// Per-project append-only change log. Every mutating API route drops a line
// here so Gemini can later mine the stream for user preferences.
//
// Storage: projects/{id}/changelog.jsonl — one JSON doc per line. Supabase
// Storage doesn't support append-on-upload, so we do read-then-overwrite.
// That's fine at MB scale (typical project = low-KB changelog).

import { isLocalStorageMode, readLocalFile, writeLocalFile } from './blob';
import { createClient } from '@supabase/supabase-js';

export type ChangeEventType =
  | 'prompt.update'
  | 'frame.generate'
  | 'frame.paste'
  | 'frame.upload'
  | 'frame.undo'
  | 'frame.redo'
  | 'frame.clear'
  | 'frame.clear.bulk'
  | 'approve'
  | 'unapprove'
  | 'voiceover.change'
  | 'voiceover.append'
  | 'refs.update'
  | 'preferences.refreshed'
  | 'ken_burns.change'
  | 'segment.lock'
  | 'segment.unlock';

// `before` and `after` stay `unknown` because the shape varies by event type:
//
//   frame.* events:   { frame_url: string, snapshot_url?: string }
//                     - `frame_url` is the public URL stored in timeline.json
//                       (which gets overwritten on the next edit; treat as
//                       a name only, not a stable byte handle).
//                     - `snapshot_url` (added 2026-04-29) is a never-overwritten
//                       copy of the BEFORE bytes at projects/{id}/snapshots/...
//                       The Gemini vision-diff path in /preferences/refresh
//                       uses this to pull the old image alongside the new one.
//                       Set by snapshotBeforeOverwrite() in app/lib/snapshots.ts.
//   voiceover.* events: { voiceover_url: string, snapshot_url?: string }
//   prompt.update:    { prompt: string, narration?: string, ... } or split-/merge-shaped
//   ken_burns.change: { ken_burns: string }
//   segment.lock/unlock: { ref_seg_id: string | null }
//   refs.update:      varies by meta.op
//
// `meta.op` namespaces sub-types:
//   prompt.update:    'timeline.merge' | 'timeline.split' | 'timeline.snap' | (none)
//   refs.update:      'segment.location' | 'segment.is_video' | 'locations.*'
//   frame.* (paste):  'autofix.borders' when the upload was auto-cropped
export type ChangeEvent = {
  ts: string;
  type: ChangeEventType;
  seg_id?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase creds missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function bucket() {
  return process.env.SUPABASE_BUCKET || 'wm-contact-sheet';
}

function changelogPath(projectId: string) {
  return `projects/${projectId}/changelog.jsonl`;
}

async function readText(path: string): Promise<string> {
  if (isLocalStorageMode()) {
    const file = await readLocalFile(path);
    return file ? file.body.toString('utf8') : '';
  }
  try {
    const { data, error } = await sb().storage.from(bucket()).download(path);
    if (error || !data) return '';
    return await data.text();
  } catch {
    return '';
  }
}

async function writeText(path: string, body: string): Promise<void> {
  if (isLocalStorageMode()) {
    await writeLocalFile(path, body);
    return;
  }
  const blob = new Blob([body], { type: 'application/x-ndjson' });
  await sb().storage.from(bucket()).upload(path, blob, { upsert: true, cacheControl: '0' });
}

/**
 * Append one event to the project's changelog. Never throws — changelog
 * writes are best-effort and must never block the main request.
 */
export async function appendChange(projectId: string, event: Omit<ChangeEvent, 'ts'>): Promise<void> {
  try {
    const full: ChangeEvent = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(full) + '\n';
    const existing = await readText(changelogPath(projectId));
    await writeText(changelogPath(projectId), existing + line);
  } catch (e) {
    // Swallow: the user's main action must succeed even if logging fails.
    console.error('[changelog] append failed', e);
  }
}

/** Read the full changelog as an array of events. Returns [] on any error. */
export async function readLog(projectId: string): Promise<ChangeEvent[]> {
  const raw = await readText(changelogPath(projectId));
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as ChangeEvent;
      } catch {
        return null;
      }
    })
    .filter((x): x is ChangeEvent => x !== null);
}
