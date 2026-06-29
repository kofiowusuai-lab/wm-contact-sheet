// POST /api/global/snapshots/cleanup
//   { older_than_days?: number, dry_run?: boolean }
//
// Walks every project's snapshot folder under projects/{id}/snapshots/** and
// deletes objects older than `older_than_days` (default 7).
//
// The snapshots are throwaway by design — they exist only long enough for
// /preferences/refresh's vision-diff pass to read them and emit a vault rule.
// The launchd puller on the user's machine POSTs here daily.
//
// Auth: same Basic-auth as the rest of the app (handled by middleware) plus
// implicit service-role via SUPABASE_SERVICE_ROLE_KEY env. No body fields are
// secret.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 120;

function sb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  return createClient(url, key, { auth: { persistSession: false } });
}

function bucketName(): string {
  return process.env.SUPABASE_BUCKET || 'wm-contact-sheet';
}

const DEFAULT_AGE_DAYS = 7;

// Filenames look like `VO_055_1729012345678.jpg` — the trailing timestamp
// before the extension is `Date.now()`. Returns ms epoch or null.
function tsFromName(name: string): number | null {
  const m = /_(\d{10,16})\.[a-z0-9]+$/i.exec(name);
  if (!m) return null;
  const t = Number(m[1]);
  if (!isFinite(t)) return null;
  // Some filenames may use seconds, some ms. Detect by magnitude — anything
  // before 2050 in seconds (< 2.5e9) we treat as seconds and convert.
  return t < 2.5e9 ? t * 1000 : t;
}

type CleanupSummary = {
  scanned_projects: number;
  scanned_objects: number;
  deleted: number;
  skipped_recent: number;
  skipped_unparseable: number;
  errors: number;
  dry_run: boolean;
  older_than_days: number;
};

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const olderThanDays = Number((body as any)?.older_than_days) || DEFAULT_AGE_DAYS;
    const dryRun = Boolean((body as any)?.dry_run);
    const cutoffMs = Date.now() - olderThanDays * 86_400_000;

    const summary: CleanupSummary = {
      scanned_projects: 0,
      scanned_objects: 0,
      deleted: 0,
      skipped_recent: 0,
      skipped_unparseable: 0,
      errors: 0,
      dry_run: dryRun,
      older_than_days: olderThanDays,
    };

    const client = sb();
    const bucket = bucketName();

    // List every project (top-level entries under `projects/`)
    const projectListing = await client.storage.from(bucket).list('projects', {
      limit: 1000,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (projectListing.error) {
      return Response.json({ error: `list projects: ${projectListing.error.message}` }, { status: 500 });
    }
    const projectIds = (projectListing.data || []).filter((e) => !e.id).map((e) => e.name);

    for (const pid of projectIds) {
      summary.scanned_projects += 1;
      // List each snapshot kind under projects/{pid}/snapshots/
      const kindsListing = await client.storage.from(bucket).list(`projects/${pid}/snapshots`, {
        limit: 100,
        offset: 0,
      });
      if (kindsListing.error) continue; // no snapshots dir yet
      const kinds = (kindsListing.data || []).filter((e) => !e.id).map((e) => e.name);

      for (const kind of kinds) {
        const dir = `projects/${pid}/snapshots/${kind}`;
        // Single page is fine — even heavy QA projects produce <1000 snapshots
        // in a 7-day window. If we exceed that, we'll need pagination here.
        const objListing = await client.storage.from(bucket).list(dir, {
          limit: 1000,
          offset: 0,
        });
        if (objListing.error) {
          summary.errors += 1;
          continue;
        }
        const toDelete: string[] = [];
        for (const obj of objListing.data || []) {
          if (obj.id == null) continue; // skip subdirs
          summary.scanned_objects += 1;
          const ts = tsFromName(obj.name);
          if (ts == null) {
            // Fall back to Supabase's created_at if we can't parse the name.
            const created = obj.created_at ? Date.parse(obj.created_at) : NaN;
            if (!isFinite(created)) {
              summary.skipped_unparseable += 1;
              continue;
            }
            if (created > cutoffMs) {
              summary.skipped_recent += 1;
              continue;
            }
          } else if (ts > cutoffMs) {
            summary.skipped_recent += 1;
            continue;
          }
          toDelete.push(`${dir}/${obj.name}`);
        }
        if (toDelete.length && !dryRun) {
          // Supabase remove() accepts up to 1000 paths per call.
          const r = await client.storage.from(bucket).remove(toDelete);
          if (r.error) {
            summary.errors += 1;
          } else {
            summary.deleted += toDelete.length;
          }
        } else if (toDelete.length) {
          summary.deleted += toDelete.length; // dry-run counts as if deleted
        }
      }
    }

    return Response.json({ ok: true, summary });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 400) }, { status: 500 });
  }
}
