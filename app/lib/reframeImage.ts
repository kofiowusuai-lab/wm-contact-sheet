'use client';

// Aspect-variant pipeline. Produces a vertical (or any-aspect) variant of
// a landscape asset by:
//
//   1. Letterboxing the source onto a target-aspect canvas with mirror-
//      padded bars above and below (not neutral grey — Grok needs texture
//      to latch onto, neutral bars produce nothing-of-style fills).
//   2. Uploading the letterboxed image to FAL.
//   3. Calling /api/generate with mode='edit' to extend the scene into
//      the mirror-padded regions.
//   4. Compositing the original source pixels back into the middle rect
//      with a feathered seam so Grok's VAE color drift at the boundary
//      is hidden. Grok WILL bleed into the preserved area otherwise; the
//      clamp is non-optional for identity preservation.
//   5. Handing the final data URL back to the caller so it can POST to
//      the variant endpoint for Supabase persistence.
//
// All canvas work is client-side, mirroring the pattern in
// `app/lib/borderMask.ts`.

import { resolveAspect, type AspectId } from './aspectRatios';
import { uploadDataUrlToFal } from './uploadImage';

// Target resolution for generated variants. Must match Grok Edit's
// output range; 1080 is the shortest side on every preset in
// aspectRatios.ts.
function targetResolution(aspect: AspectId): { w: number; h: number } {
  const preset = resolveAspect(aspect);
  return { w: preset.width, h: preset.height };
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin Supabase URLs + FAL CDN support CORS — required for
    // canvas export without tainting.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`image load failed: ${url.slice(0, 80)}`));
    img.src = url;
  });
}

/**
 * Fit-draw the source into the target canvas so the source's shorter
 * dimension touches the target's shorter dimension, centered. Returns
 * the rect where the source landed (for later mirror-padding + clamp).
 */
function fitCenter(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  targetW: number,
  targetH: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(targetW / img.width, targetH / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const x = Math.round((targetW - w) / 2);
  const y = Math.round((targetH - h) / 2);
  ctx.drawImage(img, x, y, w, h);
  return { x, y, w, h };
}

/**
 * Stage 1 — letterbox with mirror-pad bars.
 *
 * The bars are filled by flipping the source's top edge upward and its
 * bottom edge downward. This produces texture + style continuity for
 * Grok to extend, instead of the featureless fill Grok would paint
 * over solid-color bars.
 */
export async function letterboxToAspect(
  sourceUrl: string,
  aspect: AspectId,
): Promise<string> {
  const { w: W, h: H } = targetResolution(aspect);
  const img = await loadImage(sourceUrl);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const rect = fitCenter(ctx, img, W, H);

  // Top bar — mirror the source's top strip. If target is wider than
  // source, source fills horizontally already; only the top gap above
  // `rect.y` needs filling. Same for bottom.
  if (rect.y > 0) {
    // Flip-Y draw of the source's top `rect.y` pixels.
    ctx.save();
    ctx.translate(0, rect.y);
    ctx.scale(1, -1);
    // Destination: 0..rect.y flipped → -rect.y..0 after transform.
    // Source region: top rect.y rows of the letterboxed middle.
    ctx.drawImage(
      img,
      0, 0, img.width, Math.min(img.height, rect.y * (img.width / rect.w)),
      rect.x, 0, rect.w, rect.y,
    );
    ctx.restore();
  }
  if (rect.y + rect.h < H) {
    const bottomH = H - (rect.y + rect.h);
    ctx.save();
    ctx.translate(0, rect.y + rect.h + bottomH);
    ctx.scale(1, -1);
    const srcRowsNeeded = Math.min(
      img.height,
      bottomH * (img.width / rect.w),
    );
    ctx.drawImage(
      img,
      0, img.height - srcRowsNeeded, img.width, srcRowsNeeded,
      rect.x, 0, rect.w, bottomH,
    );
    ctx.restore();
  }
  // If target is taller than wide and source fills width, there are no
  // side bars to fill — `fitCenter` centered at x=0 when rect.w === W.
  // Otherwise mirror-pad sides too (not the primary use case for the
  // 16:9 → 9:16 path, but future-proofs for 4:5).
  if (rect.x > 0) {
    ctx.save();
    ctx.translate(rect.x, 0);
    ctx.scale(-1, 1);
    const srcColsNeeded = Math.min(img.width, rect.x * (img.height / rect.h));
    ctx.drawImage(
      img,
      0, 0, srcColsNeeded, img.height,
      0, rect.y, rect.x, rect.h,
    );
    ctx.restore();
  }
  if (rect.x + rect.w < W) {
    const rightW = W - (rect.x + rect.w);
    ctx.save();
    ctx.translate(rect.x + rect.w + rightW, 0);
    ctx.scale(-1, 1);
    const srcColsNeeded = Math.min(img.width, rightW * (img.height / rect.h));
    ctx.drawImage(
      img,
      img.width - srcColsNeeded, 0, srcColsNeeded, img.height,
      0, rect.y, rightW, rect.h,
    );
    ctx.restore();
  }

  // 90% JPEG is plenty — this is a staging ref for FAL, not a final
  // asset. Keeps the FAL upload payload small.
  return canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * Stage 4 — composite-back clamp.
 *
 * Overlay the original source pixels onto the middle rect of the
 * Grok-extended variant, with a 16px alpha-gradient feather at the
 * seams. The middle region becomes bit-identical to the source; only
 * the mirror-padded regions (which Grok rewrote) survive.
 */
export async function compositeMiddleBack(
  variantUrl: string,
  sourceUrl: string,
  aspect: AspectId,
): Promise<string> {
  const { w: W, h: H } = targetResolution(aspect);
  const [variant, source] = await Promise.all([
    loadImage(variantUrl),
    loadImage(sourceUrl),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  // Draw Grok's variant as the base layer.
  ctx.drawImage(variant, 0, 0, W, H);

  // Compute where the source should land (same math as letterboxToAspect).
  const scale = Math.min(W / source.width, H / source.height);
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);

  // Draw the source onto a sidecar canvas so we can apply the feather
  // mask without affecting the variant base layer.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = W;
  srcCanvas.height = H;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('2d context unavailable');
  srcCtx.drawImage(source, x, y, w, h);

  // Feather band — alpha ramps from 0 → 1 across the band at the seam,
  // so the source-vs-variant boundary fades rather than snaps.
  const feather = 16;
  const mask = document.createElement('canvas');
  mask.width = W;
  mask.height = H;
  const mctx = mask.getContext('2d');
  if (!mctx) throw new Error('2d context unavailable');
  // Solid interior.
  mctx.fillStyle = 'rgba(255,255,255,1)';
  mctx.fillRect(x + feather, y + feather, w - 2 * feather, h - 2 * feather);
  // Top feather.
  if (y > 0) {
    const topGrad = mctx.createLinearGradient(0, y, 0, y + feather);
    topGrad.addColorStop(0, 'rgba(255,255,255,0)');
    topGrad.addColorStop(1, 'rgba(255,255,255,1)');
    mctx.fillStyle = topGrad;
    mctx.fillRect(x, y, w, feather);
  } else {
    mctx.fillStyle = 'rgba(255,255,255,1)';
    mctx.fillRect(x, y, w, feather);
  }
  // Bottom feather.
  if (y + h < H) {
    const bottomGrad = mctx.createLinearGradient(0, y + h - feather, 0, y + h);
    bottomGrad.addColorStop(0, 'rgba(255,255,255,1)');
    bottomGrad.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = bottomGrad;
    mctx.fillRect(x, y + h - feather, w, feather);
  } else {
    mctx.fillStyle = 'rgba(255,255,255,1)';
    mctx.fillRect(x, y + h - feather, w, feather);
  }
  // Left / right feathers.
  if (x > 0) {
    const leftGrad = mctx.createLinearGradient(x, 0, x + feather, 0);
    leftGrad.addColorStop(0, 'rgba(255,255,255,0)');
    leftGrad.addColorStop(1, 'rgba(255,255,255,1)');
    mctx.fillStyle = leftGrad;
    mctx.fillRect(x, y + feather, feather, h - 2 * feather);
  }
  if (x + w < W) {
    const rightGrad = mctx.createLinearGradient(x + w - feather, 0, x + w, 0);
    rightGrad.addColorStop(0, 'rgba(255,255,255,1)');
    rightGrad.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = rightGrad;
    mctx.fillRect(x + w - feather, y + feather, feather, h - 2 * feather);
  }
  // Apply the mask to the source layer so only the feathered source
  // ends up drawn onto the Grok variant.
  srcCtx.globalCompositeOperation = 'destination-in';
  srcCtx.drawImage(mask, 0, 0);
  srcCtx.globalCompositeOperation = 'source-over';

  // Composite feathered source over Grok variant.
  ctx.drawImage(srcCanvas, 0, 0);

  // JPEG 92% — keeps payload under the 4.5MB Vercel cap at 1080×1920.
  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * Stage 3 — call the existing /api/generate route with mode='edit'
 * to extend the letterboxed image into its mirror-padded regions.
 * Returns the Grok output URL.
 *
 * Mirrors the polling pattern in Row.tsx editFrame.
 */
async function grokExtendLetterbox(
  letterboxedUrl: string,
): Promise<string> {
  const prompt =
    "Extend this image naturally upward and downward into the mirror-padded regions above and below the central 16:9 scene. " +
    "The extended areas should continue the room, ceiling, floor, sky, or surrounding environment that logically exists above and below the subject. " +
    "Preserve the style, palette, line quality, lighting, and painterly shading exactly. " +
    "Full-bleed. No matte, no border, no vignette, no page framing.";

  const sub = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      image_urls: [letterboxedUrl],
      product_notes: [],
      mode: 'edit',
    }),
  });
  if (!sub.ok) {
    throw new Error(`generate submit failed: ${(await sub.text()).slice(0, 120)}`);
  }
  const { status_url, response_url } = await sub.json();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const pr = await fetch('/api/generate-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status_url, response_url }),
    });
    if (!pr.ok) continue;
    const st = await pr.json();
    if (st.done && st.image_url) return st.image_url as string;
  }
  throw new Error('variant generation timed out');
}

/**
 * End-to-end orchestrator. Produces a 9:16 (or any-aspect) variant
 * of a source asset and returns the final clamped data URL ready for
 * the variant-persist endpoint.
 */
export async function generateAspectVariant(
  sourceUrl: string,
  aspect: AspectId,
  projectId?: string | null,
): Promise<string> {
  // Stage 1 — letterbox on the client.
  const letterboxedDataUrl = await letterboxToAspect(sourceUrl, aspect);
  // Stage 2 — upload letterboxed image to FAL for Grok to read.
  const staged = await uploadDataUrlToFal(letterboxedDataUrl, projectId);
  if (!staged) throw new Error('failed to upload letterboxed image to FAL');
  // Stage 3 — Grok Edit.
  const grokOut = await grokExtendLetterbox(staged);
  // Stage 4 — composite the source pixels back into the middle region.
  const clamped = await compositeMiddleBack(grokOut, sourceUrl, aspect);
  return clamped;
}
