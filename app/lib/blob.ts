// Project storage backed by Supabase Storage.
//
// The public API (listProjects, getScript, putTimeline, …) is identical to
// what the Vercel Blob version exposed, so route handlers call the same
// functions. Internally each project lives under:
//
//   wm-contact-sheet/projects/{id}/*.{json,mp3,txt,jpg}
//
// Bucket is public so frame_url points at CDN-backed URLs that <img> tags
// can load directly. Writes use the service role key (server-side only).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

export type ProjectMeta = {
  id: string;
  title: string;
  /** Series this project belongs to. Internally a project IS an "episode"
   *  in UI terms — the storage path stays `projects/{id}/…` but the UI
   *  shows it grouped under a Series. Migration is auto + idempotent from
   *  GET /api/series so legacy projects without series_id get folded into
   *  a single-episode series matching their own id. */
  series_id?: string;
  /** 1-based position of this episode within its series. Drives the
   *  Episode dropdown order. Falls back to created_at sort if missing. */
  episode_number?: number;
  /** The voice the user has picked for the project — used for the next
   *  render + shown as the picker's "selected" state. Persists across
   *  refreshes even if the voice hasn't been rendered yet. */
  voice_id?: string;
  voice_name?: string;
  /** The voice whose bytes are actually in voiceover.mp3 right now. Only
   *  updated by the TTS route + the /voiceovers/select swap + the tunnel's
   *  _record_voice_generation. Stays pinned to the previous voice if the
   *  user picks a new voice in the picker but doesn't regenerate, so the
   *  client can detect a picker/preview mismatch and fall back to the
   *  ElevenLabs sample clip instead of playing stale audio. */
  active_voice_id?: string;
  model_id?: string;
  // Output aspect ratio for render + preview. One of the ids in
  // app/lib/aspectRatios.ts ('16:9' / '9:16' / '1:1' / '4:5'). Missing means
  // legacy project — reader resolves to 16:9.
  aspect?: string;
  // Cross-episode location library this project subscribes to. When set, the
  // library's locations appear in this project's Locations panel as read-only
  // references. See global/locations/{id}.json.
  location_library_id?: string;
  /** ISO timestamp set when the user archives this episode. Absence means
   *  active (default). Archive is a UI-visibility flag — no files are moved
   *  or deleted. The dropdown filters archived episodes out by default;
   *  toggle "Show archived" to see them. PATCH with `{archived:true|false}`
   *  on /api/projects/[id]. */
  archived_at?: string;
  /** Upload metadata cached after a successful YouTube upload OR pre-filled
   *  by the user from the upload dialog. Persisting it means re-uploads of
   *  the same episode don't require retyping title/description/tags, and
   *  the dialog's defaults come from whatever was used last time. */
  upload_meta?: {
    title?: string;
    description?: string;
    /** Comma-separated tags as displayed in the dialog. The upload
     *  endpoint splits on commas. */
    tags?: string;
    /** Selected thumbnail source — either a timeline segment id (frame
     *  from that beat used as thumb) OR a public URL the user uploaded. */
    thumbnail_seg_id?: string;
    thumbnail_url?: string;
    /** Shorts vs long-form. Affects metadata (#Shorts hashtag) + a
     *  soft-validation warning when aspect/duration don't match the
     *  picked kind. Auto-picked from project aspect in the dialog. */
    kind?: 'shorts' | 'longform';
    /** Stamped on the most recent successful upload. Surfaces in the
     *  UI as "Uploaded 3h ago → youtu.be/xyz" so the user doesn't
     *  accidentally double-upload. */
    last_uploaded_at?: string;
    last_video_id?: string;
    last_video_url?: string;
    last_channel?: string;
  };
  created_at: string;
  updated_at: string;
};

export type Segment = {
  id: string;
  start: number;
  end: number;
  duration: number;
  narration: string;
  still_ref?: string;
  frame_url?: string | null;
  // Ken Burns motion + intensity stored as "<motion>:<intensity>", e.g.
  // "center_push:high". Legacy tokens (zoom_in, push_in, pan_left, pan_right,
  // zoom_out) still parse — see app/lib/kenBurns.ts.
  ken_burns?: string;
  // Aspect ratio this frame was generated at — one of the ids in
  // app/lib/aspectRatios.ts ('16:9' / '9:16' / '1:1' / '4:5'). Missing =
  // legacy segment; segmentAspect() in aspectRatios.ts resolves to '16:9'.
  // Stamped when the PUT /frames/{seg} route persists a new image.
  aspect?: string;
  // Location the frame takes place in. Matches an id in the project's
  // merged locations catalog (own locations.json + subscribed library).
  // Missing = no location binding (conceptual frames, title cards).
  location?: string;
  // 'vo'         — normal narration frame
  // 'title_card' — silent or minimal-narration overlay (LEVEL X — THE SLIP)
  // 'end_card'   — marketing CTA where product placement lives
  kind?: 'vo' | 'title_card' | 'end_card';
  // Uppercase character name when this VO was spoken by a named cast
  // member (e.g. "NIA", "RILEY"), populated by the tunnel's multi-voice
  // pipeline when the script used `@CHARACTER:` speaker tags. Empty /
  // missing = narrator. Read by the client to colour-code rows.
  speaker?: string;
  // When true, this segment should generate a SHORT VIDEO CLIP instead of
  // a still frame. Frame_url will point at an .mp4. Toggled per-segment
  // via the "Video" checkbox on Row. Generator routes to the bytedance
  // seedance text-to-video FAL model.
  is_video?: boolean;
  // Frame-continuity anchor. When set, generate routes through edit-mode
  // using THAT segment's frame_url as the reference image, and the per-
  // segment `prompt` is treated as a short edit instruction (e.g. "change
  // the laptop screen to show a cover letter") rather than a full scene
  // description. Walked transitively at generate time, hard-capped at
  // depth 8. Survives reorder because it's an explicit ID, not "previous".
  // See plans/on-some-pages-of-fizzy-cloud.md.
  ref_seg_id?: string;
};

export type PromptEntry = {
  narration?: string;
  wardrobe?: string;
  prompt: string;
  // When the user toggles ref_seg_id on for a segment that already had a
  // full scene description, the original prose is stashed here so toggling
  // back to fresh-generate restores it without retyping.
  prompt_archived?: string;
};

export type PromptsMap = Record<string, PromptEntry>;
export type Approvals = { approved: string[]; updated_at?: string };
export type Protagonist = { url: string; updated_at: string };

export type Ref = {
  url: string;
  added_at: string;
  label?: string;
  /** Free-text placement guidance: what the product is, how it should appear,
   *  and how often to include it. Only meaningful for kind="products". */
  notes?: string;
  /** Uppercased character slug (same namespace as Cast speaker tags:
   *  `@JAY`, `@SARAH`). When set, this ref is only attached to frames
   *  whose narration speaks/mentions this character. Untagged refs
   *  attach to every frame (legacy "all-frames" pool behaviour). */
  character?: string;
  /** Aspect-variant index: aspect id ("9:16", "4:5", …) → variant image
   *  URL. Absent means "no variants, the original URL is used at every
   *  aspect". The generate pipeline picks the variant matching the
   *  project's current aspect via a URL-swap at the resolution boundary
   *  (see `ContactSheet.tsx` charUrlsForSeg pickUrl). */
  variants?: Record<string, string>;
};
export type RefList = { refs: Ref[] };
export type RefKind = 'characters' | 'products';

// Per-project location catalog entry. Stored in projects/{id}/locations.json.
// Master image lives at projects/{id}/locations/{loc_id}.jpg once uploaded.
export type Location = {
  id: string;
  name: string;
  image_url: string;
  description: string;
  tags?: string[];
  added_at: string;
  updated_at: string;
  // Library-sourced locations set this to the library id. Project-owned
  // locations leave it undefined.
  from_library?: string;
  /** Aspect-variant index for the master plate: aspect id ("9:16", "4:5",
   *  …) → variant image URL. Absent = no variants, original image_url is
   *  used at every aspect. The generate pipeline picks the variant in
   *  `/api/generate/route.ts` (location resolver). */
  variants?: Record<string, string>;
};

export type LocationsDoc = {
  locations: Location[];
  updated_at: string;
};

// Shared cross-project library of locations. Stored in
// global/locations/{library_id}.json. Projects subscribe via
// meta.location_library_id; subscribed libraries' locations appear as
// read-only entries in the merged project catalog.
export type LocationLibrary = {
  id: string;
  name: string;
  owner_project_id: string;
  locations: Location[];
  created_at: string;
  updated_at: string;
};

// Top-level grouping above projects. A Series is a thin index pointing at
// one or more "episodes" (projects). Storage is a single JSON per series
// at series/{id}.json — projects keep their existing paths untouched.
// Mirrors the global/locations/{id}.json shared-library pattern, which is
// the same "sibling namespace" style already in production.
export type SeriesMeta = {
  id: string;
  title: string;
  description?: string;
  /** Ordered list of project IDs that are episodes of this series. Index
   *  in the array equals (episode_number - 1). */
  episode_ids: string[];
  /** YouTube channel slug (matches the key in
   *  ~/.openclaw/scripts/youtube/channels.json, e.g. "drstickmanreid").
   *  Set once per series, inherited by every episode's upload dialog so
   *  uploads route automatically. Unset = upload dialog shows a picker. */
  youtube_channel?: string;
  created_at: string;
  updated_at: string;
};

// Per-episode voice cast. The narrator carries everything untagged in the
// script; each named character voice is assigned when the script uses a
// `@CHARACTER:` speaker tag. Missing voice_id for a character is a hard
// fail at generate-time — the UI flags it before the user hits Generate.
export type CastEntry = {
  voice_id: string;
  voice_name: string;
};
export type CastDoc = {
  narrator: CastEntry | null;
  // Keyed by uppercase character name (e.g. "RILEY"). Writing a value of
  // null means "slot exists but no voice cast yet" — the linter shows it.
  characters: Record<string, CastEntry | null>;
  updated_at: string;
};

export type WhisperSegment = { start: number; end: number; text: string; id?: number };
export type WordsDoc = {
  total_words: number;
  total_duration: number;
  words: Array<{ word: string; start: number; end: number }>;
  full_text?: string;
  segments?: WhisperSegment[];
};

// --- Supabase client singleton ----------------------------------------------

let _client: SupabaseClient | null = null;
export function isLocalStorageMode(): boolean {
  if (process.env.WM_STORAGE === 'local') return true;
  if (process.env.WM_STORAGE === 'supabase') return false;
  return process.env.NODE_ENV !== 'production' && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function sb(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Opt every Supabase call out of Next.js's Data Cache. Without this,
      // the first empty read of a freshly-created project's prompts.json
      // (or any other file) gets cached indefinitely across requests, so
      // later writes to that file never become visible through the app's
      // GET routes — even though the file in Supabase is correct. Seen
      // empirically against SHORT001: direct REST returned 12 prompts
      // while the app kept returning 0 until we forced no-store here.
      fetch: (input, init) =>
        fetch(input as RequestInfo, { ...init, cache: 'no-store' }),
    },
  });
  return _client;
}

function bucketName(): string {
  // Trim — Vercel env add from piped stdin can leave a trailing newline in
  // the stored value, which then URL-encodes as %0A and breaks every URL.
  return (process.env.SUPABASE_BUCKET || 'wm-contact-sheet').trim();
}

export function projectPath(projectId: string, file: string): string {
  return `projects/${projectId}/${file}`;
}

export function publicUrl(pathname: string, cacheBust = true): string {
  if (isLocalStorageMode()) {
    const qs = new URLSearchParams({ path: pathname });
    if (cacheBust) qs.set('t', String(Date.now()));
    return `/api/local/file?${qs.toString()}`;
  }
  const base = sb().storage.from(bucketName()).getPublicUrl(pathname).data.publicUrl;
  return cacheBust ? `${base}?t=${Date.now()}` : base;
}

// --- Primitive read/write helpers -------------------------------------------

function localRoot(): string {
  return process.env.WM_DATA_DIR
    ? path.resolve(process.env.WM_DATA_DIR)
    : path.join(process.cwd(), '.wm-data');
}

export function safeLocalPath(pathname: string): string {
  const root = localRoot();
  const clean = pathname.replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe local path: ${pathname}`);
  }
  return full;
}

function contentTypeForPath(pathname: string): string {
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return 'application/octet-stream';
}

export async function readLocalFile(pathname: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isLocalStorageMode()) return null;
  try {
    const body = await fs.readFile(safeLocalPath(pathname));
    return { body, contentType: contentTypeForPath(pathname) };
  } catch {
    return null;
  }
}

export async function writeLocalFile(
  pathname: string,
  data: Buffer | Uint8Array | string,
): Promise<string> {
  const full = safeLocalPath(pathname);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return publicUrl(pathname, false);
}

async function readText(pathname: string): Promise<string | null> {
  if (isLocalStorageMode()) {
    try {
      return await fs.readFile(safeLocalPath(pathname), 'utf8');
    } catch {
      return null;
    }
  }
  // Bypass the Supabase SDK's download() method — it internally uses a fetch
  // that gets silently intercepted by Next.js's Data Cache + (empirically)
  // some other caching layer, and serves stale/empty responses long after
  // the underlying file has been upserted. The only reliable fix is to
  // call the storage REST endpoint directly with a cache-busting query
  // param and explicit `cache: 'no-store'`.
  //
  // Seen in prod: a freshly-upserted prompts.json held 12 entries on
  // direct REST read, while `sb().storage.download()` consistently
  // returned an empty response. The bug locked every new project's
  // prompts/timeline/refs/cast behind a stale empty cache.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const endpoint = `${url}/storage/v1/object/${bucketName()}/${pathname}?_=${Date.now()}`;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function readJson<T>(pathname: string): Promise<T | null> {
  const txt = await readText(pathname);
  if (txt == null) return null;
  try {
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

export async function writeJson(pathname: string, data: unknown): Promise<string> {
  const body = JSON.stringify(data, null, 2);
  if (isLocalStorageMode()) {
    return writeLocalFile(pathname, body);
  }
  const { error } = await sb().storage.from(bucketName()).upload(pathname, body, {
    contentType: 'application/json',
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw new Error(`supabase upload ${pathname}: ${error.message}`);
  return publicUrl(pathname, false);
}

async function writeText(pathname: string, data: string, contentType = 'text/plain; charset=utf-8'): Promise<string> {
  if (isLocalStorageMode()) {
    return writeLocalFile(pathname, data);
  }
  const { error } = await sb().storage.from(bucketName()).upload(pathname, data, {
    contentType,
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw new Error(`supabase upload ${pathname}: ${error.message}`);
  return publicUrl(pathname, false);
}

async function writeBinary(pathname: string, data: Buffer | Uint8Array, contentType: string): Promise<string> {
  if (isLocalStorageMode()) {
    return writeLocalFile(pathname, data);
  }
  const blob = new Blob([data as any], { type: contentType });
  const { error } = await sb().storage.from(bucketName()).upload(pathname, blob, {
    contentType,
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw new Error(`supabase upload ${pathname}: ${error.message}`);
  return publicUrl(pathname, false);
}

// --- Used by bulk delete / swap routes --------------------------------------

export async function removePath(pathname: string): Promise<boolean> {
  if (isLocalStorageMode()) {
    try {
      await fs.rm(safeLocalPath(pathname), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  const { error } = await sb().storage.from(bucketName()).remove([pathname]);
  return !error;
}

export async function removePaths(pathnames: string[]): Promise<string[]> {
  if (pathnames.length === 0) return [];
  if (isLocalStorageMode()) {
    const removed: string[] = [];
    for (const pathname of pathnames) {
      if (await removePath(pathname)) removed.push(pathname);
    }
    return removed;
  }
  const { data, error } = await sb().storage.from(bucketName()).remove(pathnames);
  if (error) return [];
  return (data || []).map((o: any) => o.name);
}

/** List immediate children (files + folders) of a prefix — NOT recursive. */
export async function listChildren(prefix: string): Promise<{ name: string }[]> {
  if (isLocalStorageMode()) {
    try {
      const entries = await fs.readdir(safeLocalPath(prefix), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }
  const { data, error } = await sb()
    .storage.from(bucketName())
    .list(prefix, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error || !data) return [];
  return data.map((o: any) => ({ name: o.name }));
}

// --- Project helpers --------------------------------------------------------

export async function listProjects(): Promise<ProjectMeta[]> {
  // Supabase list isn't recursive by default — get the project folders first,
  // then load each meta.json.
  const folders = await listChildren('projects');
  const metas = await Promise.all(
    folders.map((f) => getMeta(f.name)),
  );
  const out = metas.filter((m): m is ProjectMeta => m !== null);
  out.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
  return out;
}

export async function getMeta(id: string): Promise<ProjectMeta | null> {
  return readJson<ProjectMeta>(projectPath(id, 'meta.json'));
}

export async function putMeta(meta: ProjectMeta): Promise<void> {
  await writeJson(projectPath(meta.id, 'meta.json'), meta);
}

export async function deleteProject(id: string): Promise<number> {
  if (isLocalStorageMode()) {
    const base = safeLocalPath(`projects/${id}`);
    let count = 0;
    async function walk(dir: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else count++;
        }
      } catch {
        /* absent project */
      }
    }
    await walk(base);
    await fs.rm(base, { recursive: true, force: true });
    return count;
  }
  // Supabase list isn't recursive — walk the known buckets to collect paths.
  const base = `projects/${id}`;
  const all: string[] = [];
  const top = await listChildren(base);
  for (const item of top) {
    if (item.name === 'frames') {
      const frames = await listChildren(`${base}/frames`);
      for (const f of frames) all.push(`${base}/frames/${f.name}`);
    } else {
      all.push(`${base}/${item.name}`);
    }
  }
  if (all.length === 0) return 0;
  await sb().storage.from(bucketName()).remove(all);
  return all.length;
}

export async function getScript(id: string): Promise<string | null> {
  return readText(projectPath(id, 'script.txt'));
}
export async function putScript(id: string, text: string): Promise<string> {
  return writeText(projectPath(id, 'script.txt'), text);
}

export async function getTimeline(id: string): Promise<Segment[] | null> {
  return readJson<Segment[]>(projectPath(id, 'timeline.json'));
}
export async function putTimeline(id: string, segments: Segment[]): Promise<string> {
  return writeJson(projectPath(id, 'timeline.json'), segments);
}

export async function getPrompts(id: string): Promise<PromptsMap> {
  return (await readJson<PromptsMap>(projectPath(id, 'prompts.json'))) ?? {};
}
export async function putPrompts(id: string, prompts: PromptsMap): Promise<string> {
  return writeJson(projectPath(id, 'prompts.json'), prompts);
}

export async function getApprovals(id: string): Promise<Approvals> {
  return (await readJson<Approvals>(projectPath(id, 'approvals.json'))) ?? { approved: [] };
}
export async function putApprovals(id: string, approvals: Approvals): Promise<string> {
  return writeJson(projectPath(id, 'approvals.json'), approvals);
}

export async function getProtagonist(id: string): Promise<Protagonist | null> {
  return readJson<Protagonist>(projectPath(id, 'protagonist.json'));
}
export async function putProtagonist(id: string, url: string): Promise<string> {
  return writeJson(projectPath(id, 'protagonist.json'), {
    url,
    updated_at: new Date().toISOString(),
  });
}

export async function getRefs(id: string, kind: RefKind): Promise<RefList> {
  return (await readJson<RefList>(projectPath(id, `${kind}.json`))) ?? { refs: [] };
}
export async function putRefs(id: string, kind: RefKind, list: RefList): Promise<string> {
  return writeJson(projectPath(id, `${kind}.json`), list);
}

export async function getWords(id: string): Promise<WordsDoc | null> {
  return readJson<WordsDoc>(projectPath(id, 'words.json'));
}

// --- Multi-voice Cast --------------------------------------------------

export async function getCast(id: string): Promise<CastDoc | null> {
  return readJson<CastDoc>(projectPath(id, 'cast.json'));
}

export async function putCast(id: string, cast: CastDoc): Promise<string> {
  return writeJson(projectPath(id, 'cast.json'), {
    ...cast,
    updated_at: new Date().toISOString(),
  });
}
export async function putWords(id: string, words: WordsDoc): Promise<string> {
  return writeJson(projectPath(id, 'words.json'), words);
}

// --- Locations (per-project + cross-episode library) ----------------------
// locations.json lives alongside characters.json / products.json.
// Master images live in projects/{id}/locations/{loc_id}.{ext}
// Shared libraries live in global/locations/{library_id}.json.

export async function getLocations(id: string): Promise<LocationsDoc> {
  return (
    (await readJson<LocationsDoc>(projectPath(id, 'locations.json'))) ?? {
      locations: [],
      updated_at: new Date().toISOString(),
    }
  );
}
export async function putLocations(id: string, doc: LocationsDoc): Promise<string> {
  return writeJson(projectPath(id, 'locations.json'), {
    ...doc,
    updated_at: new Date().toISOString(),
  });
}

// Upload a location master image as bytes; returns the public URL.
export async function putLocationImage(
  projectId: string,
  locationId: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const path = `projects/${projectId}/locations/${locationId}.${ext}`;
  if (isLocalStorageMode()) {
    return writeBinary(path, bytes, contentType);
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  await sb().storage.from(bucketName()).upload(path, blob, { upsert: true, cacheControl: '0' });
  const { data } = sb().storage.from(bucketName()).getPublicUrl(path);
  return data.publicUrl;
}

// Upload an aspect-variant image for a character/product ref or a
// location. Stored at a deterministic path derived from the slot id +
// aspect so regenerating the same variant overwrites cleanly.
//
// slot is the logical owner: `refs/{kind}/{sha}` for a Ref variant,
// `locations/{location_id}` for a Location variant. Aspect id is
// stamped into the filename to avoid collisions across aspects.
export async function putVariantImage(
  projectId: string,
  slot: string,
  aspect: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const safeAspect = aspect.replace(/[^a-z0-9]+/gi, '-');
  const safeSlot = slot.replace(/[^a-z0-9/_-]+/gi, '-');
  const path = `projects/${projectId}/variants/${safeSlot}__${safeAspect}.${ext}`;
  if (isLocalStorageMode()) {
    return `${await writeBinary(path, bytes, contentType)}?r=${Date.now()}`;
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  await sb().storage.from(bucketName()).upload(path, blob, { upsert: true, cacheControl: '0' });
  const { data } = sb().storage.from(bucketName()).getPublicUrl(path);
  // Append a cache-buster so the new variant shows up immediately
  // after upsert — Supabase CDN otherwise serves the previous file
  // for up to a minute.
  return `${data.publicUrl}?r=${Date.now()}`;
}

function libraryPath(libraryId: string): string {
  return `global/locations/${libraryId}.json`;
}

export async function getLibrary(libraryId: string): Promise<LocationLibrary | null> {
  return readJson<LocationLibrary>(libraryPath(libraryId));
}

export async function putLibrary(lib: LocationLibrary): Promise<string> {
  return writeJson(libraryPath(lib.id), {
    ...lib,
    updated_at: new Date().toISOString(),
  });
}

export async function listLibraries(): Promise<Array<Pick<LocationLibrary, 'id' | 'name' | 'owner_project_id' | 'updated_at'>>> {
  try {
    const data = await listChildren('global/locations');
    const out: Array<Pick<LocationLibrary, 'id' | 'name' | 'owner_project_id' | 'updated_at'>> = [];
    for (const item of data) {
      if (!item.name.endsWith('.json')) continue;
      const id = item.name.replace(/\.json$/, '');
      const lib = await getLibrary(id);
      if (lib) {
        out.push({
          id: lib.id,
          name: lib.name,
          owner_project_id: lib.owner_project_id,
          updated_at: lib.updated_at,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Merged catalog: project's own locations + subscribed library's locations
// (the latter flagged via `from_library`). Duplicates (same id in both) favour
// the project-owned copy so forks work correctly.
export async function getMergedLocations(projectId: string): Promise<Location[]> {
  const meta = await getMeta(projectId);
  const doc = await getLocations(projectId);
  const own = doc.locations;
  const ownIds = new Set(own.map((l) => l.id));
  if (!meta?.location_library_id) return own;
  const lib = await getLibrary(meta.location_library_id);
  if (!lib) return own;
  const libLocs = lib.locations
    .filter((l) => !ownIds.has(l.id))
    .map((l) => ({ ...l, from_library: lib.id }));
  return [...own, ...libLocs];
}

export async function putVoiceover(id: string, audio: Buffer, contentType = 'audio/mpeg'): Promise<string> {
  return writeBinary(projectPath(id, 'voiceover.mp3'), audio, contentType);
}
export async function getVoiceoverUrl(id: string): Promise<string | null> {
  // Only return a URL if the object actually exists
  const path = projectPath(id, 'voiceover.mp3');
  if (isLocalStorageMode()) {
    try {
      await fs.access(safeLocalPath(path));
      return publicUrl(path, false);
    } catch {
      return null;
    }
  }
  const { data } = await sb().storage.from(bucketName()).list(projectPath(id, ''), {
    search: 'voiceover.mp3',
    limit: 1,
  });
  if (!data?.some((o: any) => o.name === 'voiceover.mp3')) return null;
  return publicUrl(path, false);
}

// --- Per-voice voiceover history -------------------------------------------
// Each time TTS runs with a given voice, we also write a copy keyed by
// voice_id so the user can A/B between generations without re-generating.

export type VoiceoverGeneration = {
  voice_id: string;
  voice_name: string;
  url: string;
  bytes: number;
  generated_at: string;
  model_id?: string;
};

export type VoiceoverGenerations = { generations: VoiceoverGeneration[] };

export async function putVoiceoverForVoice(
  id: string,
  voice_id: string,
  audio: Buffer,
  contentType = 'audio/mpeg',
): Promise<string> {
  if (!/^[A-Za-z0-9_\-]+$/.test(voice_id)) throw new Error('bad voice_id');
  return writeBinary(projectPath(id, `voiceovers/${voice_id}.mp3`), audio, contentType);
}

export async function getVoiceoverGenerations(id: string): Promise<VoiceoverGenerations> {
  return (
    (await readJson<VoiceoverGenerations>(projectPath(id, 'voiceover_generations.json'))) ?? {
      generations: [],
    }
  );
}

export async function recordVoiceoverGeneration(
  id: string,
  entry: VoiceoverGeneration,
): Promise<void> {
  const doc = await getVoiceoverGenerations(id);
  const existing = doc.generations.findIndex((g) => g.voice_id === entry.voice_id);
  if (existing >= 0) doc.generations[existing] = entry;
  else doc.generations.push(entry);
  await writeJson(projectPath(id, 'voiceover_generations.json'), doc);
}

export async function copyVoiceoverToActive(
  id: string,
  voice_id: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_\-]+$/.test(voice_id)) return null;
  const source = projectPath(id, `voiceovers/${voice_id}.mp3`);
  if (isLocalStorageMode()) {
    try {
      const buf = await fs.readFile(safeLocalPath(source));
      return writeBinary(projectPath(id, 'voiceover.mp3'), buf, 'audio/mpeg');
    } catch {
      return null;
    }
  }
  const { data, error } = await sb().storage.from(bucketName()).download(source);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return writeBinary(projectPath(id, 'voiceover.mp3'), buf, 'audio/mpeg');
}

// --- Frame uploads (used by /api/projects/{id}/frames/{seg}) ---------------

export async function putFrameBuffer(
  id: string,
  seg: string,
  data: Buffer,
  contentType = 'image/jpeg',
): Promise<string> {
  // Detect a video payload by the incoming Content-Type so we can write
  // it under `.mp4` instead of `.jpg`. Supabase serves the right
  // content-type on read as long as the extension matches the bytes.
  const isVideo = /^video\//i.test(contentType);
  const ext = isVideo ? 'mp4' : 'jpg';
  const path = projectPath(id, `frames/${seg}.${ext}`);
  return writeBinary(path, data, contentType);
}

export function framePath(id: string, seg: string): string {
  return projectPath(id, `frames/${seg}.jpg`);
}

/** Frame path override for video segments — matches the .mp4 extension
 *  putFrameBuffer writes when the upload was a video/* payload. */
export function frameVideoPath(id: string, seg: string): string {
  return projectPath(id, `frames/${seg}.mp4`);
}

// --- Series (top-level grouping of episodes) -----------------------------

function seriesPath(id: string): string {
  return `series/${id}.json`;
}

export async function getSeriesMeta(id: string): Promise<SeriesMeta | null> {
  return readJson<SeriesMeta>(seriesPath(id));
}

export async function putSeriesMeta(series: SeriesMeta): Promise<string> {
  return writeJson(seriesPath(series.id), {
    ...series,
    updated_at: new Date().toISOString(),
  });
}

export async function removeSeriesMeta(id: string): Promise<boolean> {
  return removePath(seriesPath(id));
}

// Lists every SeriesMeta. Mirrors listLibraries — list the folder, filter
// .json, strip the extension, then hydrate each. Returns [] on error so
// callers can render an empty SeriesBar instead of a hard failure.
export async function listSeries(): Promise<SeriesMeta[]> {
  try {
    const data = await listChildren('series');
    const out: SeriesMeta[] = [];
    for (const item of data) {
      if (!item.name.endsWith('.json')) continue;
      const id = item.name.replace(/\.json$/, '');
      const meta = await getSeriesMeta(id);
      if (meta) out.push(meta);
    }
    return out;
  } catch {
    return [];
  }
}
