// Shared single-frame Generate flow: submit to FAL, poll until done,
// persist to Blob. Returns the versioned frame_url on success.
//
// Called by Row.tsx (single frame) and ContactSheet.tsx (bulk).

import { detectPageBorder, NO_BORDER_AMENDMENT, type FrameQaReport } from './qaFrame';
import { autoFixBorders } from './autoFixBorders';

export type GenerateResult = {
  ok: boolean;
  frame_url?: string;
  error?: string;
  /** QA verdict on the frame actually persisted. Absent when the generate
   *  itself failed. `passed: false` means QA flagged it (e.g. matte border)
   *  and we already auto-retried up to `qaRetries` times. */
  qa?: FrameQaReport;
  /** How many times we re-ran the generate because QA flagged the first
   *  attempt. 0 means the first output passed. */
  qaRetries?: number;
};

export async function generateFrame(opts: {
  projectId: string;
  segId: string;
  prompt: string;
  imageUrls?: string[];
  productNotes?: string[];
  tunnelUrl?: string | null;
  pollIntervalMs?: number;
  maxPolls?: number;
  // 'edit' uses the supplied image_urls as the reference for a targeted
  // rewrite ("zoom out", "remove the smile", etc.). Omit for fresh generate.
  mode?: 'edit';
  // Aspect stamped onto the segment when the Blob PUT lands and passed to
  // FAL as the target image_size. Keep in sync with app/lib/aspectRatios.ts.
  aspect?: string;
  // Location id from the project's merged catalog. When set, the server
  // resolves it, prepends the location's master image to image_urls[] and
  // injects the canonical description into the prompt.
  location?: string;
  // Internal retry counter — callers leave this at 0. The QA-failure branch
  // bumps it when re-entering to cap how many times we re-roll a bordered
  // output before accepting the result.
  _qaRetry?: number;
  // Max auto-retries when QA flags a bordered / matted render. Default 1 so
  // a single regen with the anti-border directive is our budget per frame.
  qaRetries?: number;
  // When true, the PUT to /frames/{seg} uploads the image to storage but
  // does NOT patch timeline.json. The caller must flush its own
  // {segId, frame_url} updates through /frames/batch-patch. Used by the
  // bulk generator to avoid the parallel-write race on timeline.json.
  deferTimelinePatch?: boolean;
}): Promise<GenerateResult> {
  const {
    projectId,
    segId,
    prompt,
    imageUrls = [],
    productNotes = [],
    tunnelUrl,
    pollIntervalMs = 2500,
    maxPolls = 60,
    mode,
    aspect,
    location,
    _qaRetry = 0,
    qaRetries = 1,
    deferTimelinePatch = false,
  } = opts;
  const text = (prompt || '').trim();
  if (!text) return { ok: false, error: 'empty prompt' };
  const effectivePrompt = _qaRetry > 0 ? `${text}${NO_BORDER_AMENDMENT}` : text;

  let sub: Response;
  try {
    sub = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: effectivePrompt,
        image_urls: imageUrls,
        product_notes: productNotes,
        ...(mode ? { mode } : {}),
        ...(aspect ? { aspect } : {}),
        ...(location ? { location, project_id: projectId } : {}),
      }),
    });
  } catch (e: any) {
    return { ok: false, error: `submit: ${String(e?.message || e).slice(0, 80)}` };
  }
  if (!sub.ok) return { ok: false, error: `submit ${sub.status}: ${(await sub.text()).slice(0, 80)}` };
  const submitted = await sub.json().catch(() => null);
  if (!submitted?.status_url || !submitted?.response_url) return { ok: false, error: 'bad submit response' };

  let imageUrl: string | null = null;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const pr = await fetch('/api/generate-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status_url: submitted.status_url,
          response_url: submitted.response_url,
        }),
      });
      if (!pr.ok) continue;
      const st = await pr.json();
      if (st.done && st.image_url) {
        imageUrl = st.image_url;
        break;
      }
    } catch {
      // transient — keep polling
    }
  }
  if (!imageUrl) return { ok: false, error: 'timeout' };

  // Auto-crop any white matte BEFORE the blob write, so the persisted frame
  // is always full-bleed. Pass-through no-op when FAL returned a clean image.
  const fix = await autoFixBorders(imageUrl);
  const persistBody: Record<string, unknown> = fix.fixed
    ? { data_url: fix.image }
    : { image_url: imageUrl };
  if (aspect) persistBody.aspect = aspect;
  if (deferTimelinePatch) persistBody.skip_timeline_patch = true;
  // Tag autocropped uploads so the changelog records meta.op='autofix.borders'.
  // /preferences/refresh's vision-diff prompt conditions on this so Gemini
  // understands the diff is "what got trimmed" rather than a user-driven
  // visual swap. Untouched (fix.fixed === false) uploads stay un-tagged.
  if (fix.fixed) {
    persistBody.meta = { op: 'autofix.borders', cropped_frac: fix.cropped_frac };
  }

  // Persist to Blob
  let frame_url: string | undefined;
  try {
    const putR = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(persistBody),
      },
    );
    if (!putR.ok) return { ok: false, error: `blob ${putR.status}: ${(await putR.text()).slice(0, 80)}` };
    const j = await putR.json().catch(() => ({}));
    frame_url = j?.frame_url;
  } catch (e: any) {
    return { ok: false, error: `blob: ${String(e?.message || e).slice(0, 80)}` };
  }

  // Mirror to local tunnel if available (non-fatal). Use the persisted URL so
  // the tunnel grabs the already-cropped frame, not the raw FAL output.
  if (tunnelUrl && frame_url) {
    fetch(`${tunnelUrl.replace(/\/+$/, '')}/swap/${segId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: frame_url }),
    }).catch(() => {});
  }

  // QA the persisted frame for matted-page rendering. If it fails and we
  // have retries left, re-enter this function with the budget reduced and
  // the anti-border amendment appended to the prompt on the next pass.
  const qa = frame_url ? await detectPageBorder(frame_url) : undefined;
  if (qa && !qa.passed && _qaRetry < qaRetries) {
    return generateFrame({ ...opts, _qaRetry: _qaRetry + 1 });
  }
  return { ok: true, frame_url, qa, qaRetries: _qaRetry };
}

/**
 * Run generateFrame over many segments with a concurrency cap.
 * onProgress fires after each completion with (done, total, lastResult).
 */
// Preload a URL via <img> so the browser caches the bytes. Resolves when the
// image actually decodes (i.e. it's visible in the frame slot, not just
// "written to Blob"). Retries a few times because Supabase's public CDN
// occasionally 404s for a few hundred ms right after a fresh upload.
function preloadImage(url: string, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(true);
    let attempts = 0;
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      attempts++;
      const img = new Image();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (ok) {
          resolve(true);
        } else if (Date.now() < deadline && attempts < 6) {
          window.setTimeout(tryOnce, 400 * attempts); // 400ms, 800ms, 1200ms…
        } else {
          resolve(false);
        }
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      // Cache-bust each retry so the browser doesn't cache the 404
      img.src = url.includes('?') ? `${url}&r=${attempts}` : `${url}?r=${attempts}`;
    };
    tryOnce();
  });
}

export async function generateAll(
  items: Array<{
    segId: string;
    prompt: string;
    includeProduct: boolean;
    /** Per-segment location id — overrides opts.location for this item. */
    location?: string;
    /** Per-segment character reference URLs — overrides
     *  opts.characterImageUrls when supplied. Lets the caller filter
     *  which character refs attach to this specific frame (matches the
     *  single-Row path, which now filters by @CHARACTER mentions). */
    characterImageUrls?: string[];
  }>,
  opts: {
    projectId: string;
    // Character references pass to every frame.
    // Product references + notes only pass to items where includeProduct is true.
    characterImageUrls?: string[];
    productImageUrls?: string[];
    productNotes?: string[];
    tunnelUrl?: string | null;
    // Project-wide aspect at submit time. All frames generated in this run
    // get stamped with it.
    aspect?: string;
    // Sequential by default — each frame must be visible before the next
    // starts. Callers can set >1 to relax that guarantee.
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, last: GenerateResult & { segId: string }) => void;
  },
): Promise<{ succeeded: number; failed: number; errors: Record<string, string>; halted?: string }> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const total = items.length;
  let done = 0;
  let succeeded = 0;
  let failed = 0;
  const errors: Record<string, string> = {};
  let halted: string | undefined;

  const characterImageUrls = opts.characterImageUrls ?? [];
  const productImageUrls = opts.productImageUrls ?? [];
  const productNotes = opts.productNotes ?? [];

  let cursor = 0;
  async function worker() {
    for (;;) {
      if (halted) return;
      if (opts.signal?.aborted) {
        halted = 'stopped by user';
        return;
      }
      const idx = cursor++;
      if (idx >= items.length) return;
      const { segId, prompt, includeProduct, location, characterImageUrls: perItemChars } =
        items[idx];
      const charUrls = perItemChars ?? characterImageUrls;
      const res = await generateFrame({
        projectId: opts.projectId,
        segId,
        prompt,
        imageUrls: includeProduct
          ? [...charUrls, ...productImageUrls]
          : charUrls,
        productNotes: includeProduct ? productNotes : [],
        tunnelUrl: opts.tunnelUrl ?? null,
        aspect: opts.aspect,
        location,
        // Defer the timeline.json write — we'll batch those below so N
        // parallel workers don't overwrite each other's updates.
        deferTimelinePatch: true,
      });

      // Best-effort preload so the next row's generate doesn't kick off until
      // the browser can see the current one. Non-fatal — the frame IS in
      // Supabase even if the CDN hasn't propagated yet; flagging failure
      // here just delays the UI update by one refresh.
      if (res.ok && res.frame_url) {
        await preloadImage(res.frame_url);
        pendingPatches.push({ segId, frame_url: res.frame_url, aspect: opts.aspect });
        // Flush opportunistically once enough updates queue up. Keeps a
        // steady drip of timeline writes so the UI doesn't lose everything
        // if the user closes the tab mid-run.
        if (pendingPatches.length >= FLUSH_THRESHOLD) {
          const batch = pendingPatches.splice(0);
          void flushBatch(batch);
        }
      }

      done++;
      if (res.ok) succeeded++;
      else {
        failed++;
        errors[segId] = res.error || 'unknown';
        const err = (res.error || '').toLowerCase();
        if (/403|user is locked|exhausted|unauthorized|401/.test(err)) {
          halted = res.error || 'account locked';
        }
      }
      opts.onProgress?.(done, total, { ...res, segId });
    }
  }

  // Accumulator + flush machinery for timeline.json batch writes.
  const pendingPatches: Array<{ segId: string; frame_url: string; aspect?: string }> = [];
  const FLUSH_THRESHOLD = 8;
  let flushChain: Promise<void> = Promise.resolve();
  async function flushBatch(batch: typeof pendingPatches) {
    if (batch.length === 0) return;
    // Serialize batch PUTs so two concurrent flushes can't themselves race.
    flushChain = flushChain.then(async () => {
      try {
        await fetch(
          `/api/projects/${encodeURIComponent(opts.projectId)}/frames/batch-patch`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              updates: batch.map((b) => ({
                seg_id: b.segId,
                frame_url: b.frame_url,
                ...(b.aspect ? { aspect: b.aspect } : {}),
              })),
            }),
          },
        );
      } catch {
        // A failed flush means those frames still have their image in
        // storage but not in timeline.json. The reconcile script handles
        // that case, and a later flush will usually succeed on retry.
      }
    });
    return flushChain;
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  // Final flush for anything left under the threshold.
  if (pendingPatches.length > 0) {
    const batch = pendingPatches.splice(0);
    await flushBatch(batch);
  }
  await flushChain;
  return { succeeded, failed, errors, halted };
}

/**
 * Mass-apply an edit instruction to every segment with a current frame_url.
 * Each frame's existing image becomes the ONLY reference for its edit, so
 * tweaks stay localised (e.g. "zoom out slightly, show more environment"
 * preserves the subject + wardrobe while widening the composition).
 */
export async function editAll(
  items: Array<{ segId: string; currentFrameUrl: string }>,
  opts: {
    projectId: string;
    instruction: string;
    tunnelUrl?: string | null;
    concurrency?: number;
    signal?: AbortSignal;
    /** Optional product to place in every frame. When set, the product
     *  image is attached as a second ref and the instruction becomes
     *  placement guidance rather than a generic edit. */
    attachedProduct?: { url: string; label: string } | null;
    onProgress?: (done: number, total: number, last: GenerateResult & { segId: string }) => void;
  },
): Promise<{ succeeded: number; failed: number; errors: Record<string, string>; halted?: string }> {
  const instruction = (opts.instruction || '').trim();
  if (!instruction) {
    return { succeeded: 0, failed: 0, errors: {}, halted: 'empty instruction' };
  }
  const attachedProduct = opts.attachedProduct ?? null;
  const effectivePrompt = attachedProduct
    ? `Place the ${attachedProduct.label} shown in the second reference image naturally into this scene. Placement: ${instruction}. Keep every other aspect of the scene identical — character, pose, wardrobe, lighting, composition, framing, background.`
    : instruction;
  const concurrency = Math.max(1, opts.concurrency ?? Math.min(items.length, 8));
  const total = items.length;
  let done = 0;
  let succeeded = 0;
  let failed = 0;
  const errors: Record<string, string> = {};
  let halted: string | undefined;

  let cursor = 0;
  async function worker() {
    for (;;) {
      if (halted) return;
      if (opts.signal?.aborted) {
        halted = 'stopped by user';
        return;
      }
      const idx = cursor++;
      if (idx >= items.length) return;
      const { segId, currentFrameUrl } = items[idx];
      const res = await generateFrame({
        projectId: opts.projectId,
        segId,
        prompt: effectivePrompt,
        imageUrls: attachedProduct
          ? [currentFrameUrl, attachedProduct.url]
          : [currentFrameUrl],
        mode: 'edit',
        tunnelUrl: opts.tunnelUrl ?? null,
      });
      if (res.ok && res.frame_url) {
        await preloadImage(res.frame_url);
      }
      done++;
      if (res.ok) succeeded++;
      else {
        failed++;
        errors[segId] = res.error || 'unknown';
        const err = (res.error || '').toLowerCase();
        if (/403|user is locked|exhausted|unauthorized|401/.test(err)) {
          halted = res.error || 'account locked';
        }
      }
      opts.onProgress?.(done, total, { ...res, segId });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return { succeeded, failed, errors, halted };
}
