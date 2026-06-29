// Client-side QA for freshly-generated frames. Right now it checks one thing:
// whether the model returned a matted / bordered illustration instead of a
// full-bleed image. We see this often on Grok Imagine when the model renders
// a "book page" style with a cream paper border around the actual art — the
// frame then looks fine in the contact sheet but renders with visible bars
// when Ken Burns zooms.
//
// The check is a cheap offscreen-canvas pass that samples every edge pixel,
// counts how many are near-uniform and near-white, and returns a verdict.
// No server call, no extra deps.

export type FrameQaReport = {
  passed: boolean;
  /** 0-1. Fraction of sampled edge pixels that looked like a page matte. */
  borderCoverage: number;
  /** One-line human-friendly explanation. */
  reason?: string;
  /** Width × height of the image we inspected — useful for logs. */
  dimensions?: { width: number; height: number };
};

const BORDER_COVERAGE_THRESHOLD = 0.62; // fraction of edge that must look like matte
const EDGE_SAMPLE_BAND = 0.025; // inspect the outermost 2.5% of the image
const NEAR_WHITE_MIN = 228; // per-channel min to count as "near-white"
const CHANNEL_SPREAD_MAX = 18; // how far R/G/B can diverge on a matte pixel

export function isMattePixel(r: number, g: number, b: number): boolean {
  if (r < NEAR_WHITE_MIN || g < NEAR_WHITE_MIN || b < NEAR_WHITE_MIN) return false;
  // Reject pure colored light (e.g. warm lamp blown-out highlight) — matte
  // pixels are close to grey/cream with tight channel spread.
  const maxCh = Math.max(r, g, b);
  const minCh = Math.min(r, g, b);
  return maxCh - minCh <= CHANNEL_SPREAD_MAX;
}

export async function detectPageBorder(imageUrl: string): Promise<FrameQaReport> {
  if (typeof window === 'undefined') {
    return { passed: true, borderCoverage: 0, reason: 'qa skipped (ssr)' };
  }
  try {
    // Use a fresh <img> so we inherit the page's cookie/CORS scope. Supabase
    // public URLs are anonymous-readable but we still need crossOrigin set so
    // the canvas read-back doesn't throw SecurityError.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = imageUrl + (imageUrl.includes('?') ? '&qa=1' : '?qa=1');
    });

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return { passed: true, borderCoverage: 0, reason: 'zero-size image' };

    // Downscale to a fixed analysis resolution so huge 2K outputs don't cost
    // more time than necessary. 512×288 is plenty for border detection.
    const maxDim = 512;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const aw = Math.max(1, Math.round(w * scale));
    const ah = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = aw;
    canvas.height = ah;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { passed: true, borderCoverage: 0, reason: 'no canvas ctx' };
    ctx.drawImage(img, 0, 0, aw, ah);

    const bandPx = Math.max(2, Math.round(Math.min(aw, ah) * EDGE_SAMPLE_BAND));
    let sampleCount = 0;
    let matteCount = 0;

    // Top + bottom bands: step every 4 pixels along x, every 2 along the band.
    const step = 4;
    for (let x = 0; x < aw; x += step) {
      for (let y = 0; y < bandPx; y++) {
        const top = ctx.getImageData(x, y, 1, 1).data;
        const bot = ctx.getImageData(x, ah - 1 - y, 1, 1).data;
        if (isMattePixel(top[0], top[1], top[2])) matteCount++;
        if (isMattePixel(bot[0], bot[1], bot[2])) matteCount++;
        sampleCount += 2;
      }
    }
    // Left + right bands.
    for (let y = 0; y < ah; y += step) {
      for (let x = 0; x < bandPx; x++) {
        const left = ctx.getImageData(x, y, 1, 1).data;
        const right = ctx.getImageData(aw - 1 - x, y, 1, 1).data;
        if (isMattePixel(left[0], left[1], left[2])) matteCount++;
        if (isMattePixel(right[0], right[1], right[2])) matteCount++;
        sampleCount += 2;
      }
    }

    const coverage = sampleCount > 0 ? matteCount / sampleCount : 0;
    const passed = coverage < BORDER_COVERAGE_THRESHOLD;
    return {
      passed,
      borderCoverage: coverage,
      reason: passed
        ? undefined
        : `${Math.round(coverage * 100)}% of edge pixels look like a page matte — model rendered a bordered illustration`,
      dimensions: { width: w, height: h },
    };
  } catch (e: any) {
    // Never fail generation because QA itself broke — treat as pass.
    return { passed: true, borderCoverage: 0, reason: `qa error: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/**
 * Amendment appended to a prompt when we detect a bordered render. Kept as
 * an explicit exported constant so Row.tsx's "retry" affordance can reuse it.
 */
export const NO_BORDER_AMENDMENT =
  ' CRITICAL RENDER REQUIREMENT: full-bleed image, NO BORDER, NO MATTE, NO CREAM OR WHITE PADDING around the illustration. The artwork must extend to the absolute physical edges of the frame on all four sides — no paper background visible anywhere. Edge to edge, corner to corner. Do NOT render this as a framed book page or magazine layout.';
