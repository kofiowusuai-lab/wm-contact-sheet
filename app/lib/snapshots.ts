// Snapshot-before-overwrite helper.
//
// Every byte-overwriting write path in the contact sheet (frame PUT/DELETE,
// voiceover regen, voiceover append) calls this BEFORE the new bytes land.
// We copy the existing Supabase object to a never-overwritten snapshot path
// under projects/{id}/snapshots/{kind}/{seg}_{ts}.{ext}. The returned URL is
// stamped into the changelog event's `before.snapshot_url` so the Gemini
// vision-diff path in /preferences/refresh can fetch the old bytes alongside
// the new ones.
//
// Lifecycle: snapshots auto-prune after 7 days via cleanup_snapshots.py
// (cron'd from launchd). The persistent artifact is the rule that lands in
// the Obsidian vault, not the snapshot itself.
//
// Server-side copy via Supabase Storage's `copy()` — no bytes transit through
// the lambda, so the overhead is bounded by Supabase RTT (~50–200ms).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalStorageMode, publicUrl as storagePublicUrl, readLocalFile, writeLocalFile } from './blob';

function sb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  return createClient(url, key, { auth: { persistSession: false } });
}

function bucketName(): string {
  return process.env.SUPABASE_BUCKET || 'wm-contact-sheet';
}

function publicUrl(pathname: string): string {
  const base = sb().storage.from(bucketName()).getPublicUrl(pathname).data.publicUrl;
  return base; // no cache-bust — the snapshot path is unique per timestamp
}

export type SnapshotKind = 'frames' | 'voiceover' | 'voiceovers' | 'protagonist' | 'characters' | 'products' | 'locations';

export type SnapshotResult = {
  snapshot_url: string;
  snapshot_path: string;
};

/**
 * Copy the existing object at `sourcePath` to a unique snapshot path. Returns
 * `null` if the source doesn't exist (first edit on a fresh segment) or if
 * the copy fails — callers MUST treat null as "no before-state" and fall
 * through to the existing changelog flow.
 *
 * `kind` segments the snapshot directory so cleanup + queries can target a
 * subset (e.g. only frame snapshots). `seg` is the segment id ('VO_055') for
 * frames, or 'main' / 'append' for voiceover. `ext` is the file extension
 * ('jpg', 'mp4', 'mp3') used both to read the source and write the snapshot.
 */
export async function snapshotBeforeOverwrite(
  projectId: string,
  kind: SnapshotKind,
  seg: string,
  ext: string,
): Promise<SnapshotResult | null> {
  if (!projectId || !kind || !seg) return null;
  // Source path matches the canonical asset paths used elsewhere in blob.ts.
  // We don't import them to avoid a circular dependency — strings are stable.
  const safeExt = ext.replace(/^\.+/, '').toLowerCase();
  const sourcePath = sourcePathFor(projectId, kind, seg, safeExt);
  if (!sourcePath) return null;

  const ts = Date.now();
  const snapshotPath = `projects/${projectId}/snapshots/${kind}/${seg}_${ts}.${safeExt}`;

  if (isLocalStorageMode()) {
    const source = await readLocalFile(sourcePath);
    if (!source) return null;
    await writeLocalFile(snapshotPath, source.body);
    return { snapshot_url: storagePublicUrl(snapshotPath, false), snapshot_path: snapshotPath };
  }

  // Cheap existence check — if the source isn't there, this is the first
  // write on the segment and there's nothing to snapshot.
  try {
    const probe = await sb().storage.from(bucketName()).list(
      sourcePath.split('/').slice(0, -1).join('/'),
      { search: sourcePath.split('/').pop()! },
    );
    if (probe.error) return null;
    if (!probe.data?.length) return null;
  } catch {
    return null;
  }

  // Server-side copy. No bytes pass through the lambda.
  const { error } = await sb().storage.from(bucketName()).copy(sourcePath, snapshotPath);
  if (error) {
    // Don't throw — snapshot failure must NEVER block the user's edit. We
    // log via console so Vercel captures it; caller proceeds with null.
    // eslint-disable-next-line no-console
    console.warn(`[snapshots] copy ${sourcePath} → ${snapshotPath} failed: ${error.message}`);
    return null;
  }
  return { snapshot_url: publicUrl(snapshotPath), snapshot_path: snapshotPath };
}

function sourcePathFor(projectId: string, kind: SnapshotKind, seg: string, ext: string): string | null {
  switch (kind) {
    case 'frames':
      return `projects/${projectId}/frames/${seg}.${ext}`;
    case 'voiceover':
      // The active voiceover. `seg` is ignored (always 'main'); ext is mp3.
      return `projects/${projectId}/voiceover.${ext}`;
    case 'voiceovers':
      // Per-voice archive. `seg` is the voice_id.
      return `projects/${projectId}/voiceovers/${seg}.${ext}`;
    case 'protagonist':
      return `projects/${projectId}/protagonist.${ext}`;
    case 'characters':
      return `projects/${projectId}/characters/${seg}.${ext}`;
    case 'products':
      return `projects/${projectId}/products/${seg}.${ext}`;
    case 'locations':
      return `projects/${projectId}/locations/${seg}.${ext}`;
    default:
      return null;
  }
}
