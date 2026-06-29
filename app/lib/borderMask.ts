// Client-side helpers for the "Fix borders" action: detect the cream/white
// page-matte around a bordered frame, crop it off, and upscale the real art
// back to the original resolution so it fills the frame edge-to-edge. No
// generative model involved — we learnt the hard way that Flux Pro Fill
// interprets the preserved interior as "a framed page" and collages random
// scenes around it, which is the opposite of what we want.
//
// Detection is tuned MORE aggressively than qaFrame.ts's matte predicate
// because qaFrame is for Gemini scoring (conservative to avoid false positive
// flags) while here we're committed to removing the matte from a row the user
// has already ticked, so we'd rather over-crop a pixel or two than leave any
// cream visible.
//
// Exported:
//   detectBorderBounds(url)              -> { bounds, width, height }
//   cropAndUpscaleToFullBleed(url)       -> { data_url, bounds, width, height }

export type BorderBounds = {
  /** Pixels of matte running inward from the top edge (0 = no matte detected). */
  top: number;
  bottom: number;
  left: number;
  right: number;
};

const MAX_BAND_FRAC = 0.22; // never crop more than 22% inward from any edge
const MIN_RUN_PX = 3;       // require a short run of non-matte rows before we declare art found
const SCAN_STEP = 3;        // sample every Nth column on each scan row
const SAFETY_INSET_FRAC = 0.01; // crop an extra 1% past the detected matte to guarantee no cream leak
const FALLBACK_FRAC = 0.03; // if detection found nothing, crop a minimum 3% per side anyway

// Relaxed matte test — catches cream/beige/pale grey that qaFrame.ts's
// stricter predicate would reject. We're intentionally willing to mistake a
// pale sky for matte here because the row-level ≥80% majority vote in
// rowIsMostlyMatte rescues non-matte rows where sky is only part of the scene.
const NEAR_WHITE_MIN = 205;
const CHANNEL_SPREAD_MAX = 32;

function isMatteRelaxed(r: number, g: number, b: number): boolean {
  if (r < NEAR_WHITE_MIN || g < NEAR_WHITE_MIN || b < NEAR_WHITE_MIN) return false;
  const maxCh = Math.max(r, g, b);
  const minCh = Math.min(r, g, b);
  return maxCh - minCh <= CHANNEL_SPREAD_MAX;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image load failed'));
    // Cache-bust so <canvas> read-back never hits a stale CORS-less copy.
    el.src = url + (url.includes('?') ? '&mask=1' : '?mask=1');
  });
}

function getContext(img: HTMLImageElement): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  data: Uint8ClampedArray;
} {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas ctx');
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { ctx, w, h, data };
}

// At pixel (x, y) inspect one row/col of matte pixels to decide if the whole
// line still looks like matte. Used to find the first row/col where the real
// illustration begins, tolerating a small number of cream-ish pixels inside
// the art (e.g. a pale wall) before declaring we're out of the border.
function rowIsMostlyMatte(data: Uint8ClampedArray, w: number, y: number): boolean {
  let matte = 0;
  let total = 0;
  for (let x = 0; x < w; x += SCAN_STEP) {
    const i = (y * w + x) * 4;
    if (isMatteRelaxed(data[i], data[i + 1], data[i + 2])) matte++;
    total++;
  }
  // Call it a matte row if ≥70% of sampled pixels look like matte. Lower
  // than qaFrame.ts's implicit 62% because we're scanning full rows here,
  // not edge bands, and we want to keep scanning inward past any blended
  // "matte + first pixel of art" transition rows.
  return total > 0 && matte / total >= 0.7;
}

function colIsMostlyMatte(data: Uint8ClampedArray, w: number, h: number, x: number): boolean {
  let matte = 0;
  let total = 0;
  for (let y = 0; y < h; y += SCAN_STEP) {
    const i = (y * w + x) * 4;
    if (isMatteRelaxed(data[i], data[i + 1], data[i + 2])) matte++;
    total++;
  }
  return total > 0 && matte / total >= 0.7;
}

export async function detectBorderBounds(imageUrl: string): Promise<{
  bounds: BorderBounds;
  width: number;
  height: number;
}> {
  const img = await loadImage(imageUrl);
  const { w, h, data } = getContext(img);
  const maxTop = Math.floor(h * MAX_BAND_FRAC);
  const maxBottom = Math.floor(h * MAX_BAND_FRAC);
  const maxLeft = Math.floor(w * MAX_BAND_FRAC);
  const maxRight = Math.floor(w * MAX_BAND_FRAC);

  // Scan inward until we hit MIN_RUN_PX consecutive non-matte rows/cols.
  const scanFrom = (
    limit: number,
    isMatte: (k: number) => boolean,
  ): number => {
    let run = 0;
    for (let k = 0; k < limit; k++) {
      if (isMatte(k)) {
        run = 0;
      } else {
        run++;
        if (run >= MIN_RUN_PX) return Math.max(0, k - MIN_RUN_PX + 1);
      }
    }
    return limit;
  };

  const top = scanFrom(maxTop, (k) => rowIsMostlyMatte(data, w, k));
  const bottom = scanFrom(maxBottom, (k) => rowIsMostlyMatte(data, w, h - 1 - k));
  const left = scanFrom(maxLeft, (k) => colIsMostlyMatte(data, w, h, k));
  const right = scanFrom(maxRight, (k) => colIsMostlyMatte(data, w, h, w - 1 - k));

  return { bounds: { top, bottom, left, right }, width: w, height: h };
}

// End-to-end helper the UI calls per row. Loads the frame, detects the
// matte bounds, crops the art out, upscales the crop back to the original
// resolution (keeping the frame's aspect exactly), and returns a JPEG data
// URL the caller can PUT straight at /api/projects/{id}/frames/{seg}.
//
// Why upscale-to-original instead of cropping to a smaller image: the rest
// of the pipeline (Row.tsx preview, Ken Burns render, final ffmpeg concat)
// all assume a consistent per-frame resolution matching the project's aspect.
// Changing dimensions mid-timeline would break the Ken Burns safe-zone
// calculations and force every downstream step to renormalise.
export async function cropAndUpscaleToFullBleed(imageUrl: string): Promise<{
  data_url: string;
  bounds: BorderBounds;
  width: number;
  height: number;
  cropped_out_frac: number;
}> {
  const { bounds, width, height } = await detectBorderBounds(imageUrl);

  // Reload the image because detectBorderBounds already consumed one decode
  // pass; browsers cache the decoded bitmap so this is effectively free.
  const img = await loadImage(imageUrl);

  // Apply the safety inset on top of the detected matte so any one-pixel
  // sliver of cream that barely missed the threshold still gets cropped.
  // Fall back to a 3% baseline if detection didn't find anything — Gemini
  // already flagged this row as bordered, so something is there even if
  // our relaxed predicate missed it.
  const safetyX = Math.round(width * SAFETY_INSET_FRAC);
  const safetyY = Math.round(height * SAFETY_INSET_FRAC);
  const fallbackX = Math.round(width * FALLBACK_FRAC);
  const fallbackY = Math.round(height * FALLBACK_FRAC);

  const totalDetected = bounds.top + bounds.bottom + bounds.left + bounds.right;
  const useFallback = totalDetected === 0;

  const top = useFallback ? fallbackY : bounds.top + safetyY;
  const bottom = useFallback ? fallbackY : bounds.bottom + safetyY;
  const left = useFallback ? fallbackX : bounds.left + safetyX;
  const right = useFallback ? fallbackX : bounds.right + safetyX;

  const artW = Math.max(1, width - left - right);
  const artH = Math.max(1, height - top - bottom);

  // Render the crop at the original resolution so the frame's aspect ratio
  // is preserved exactly. If the detected matte is non-uniform (e.g. taller
  // on top than on left) the crop rectangle itself has a different aspect
  // than the frame, and drawImage here will stretch one axis to match —
  // which is fine because the matte is thin and the distortion is under a
  // couple of percent; the alternative (letter-boxing the crop) would
  // reintroduce a black border which defeats the whole point.
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('no canvas ctx');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, left, top, artW, artH, 0, 0, width, height);

  const data_url = out.toDataURL('image/jpeg', 0.94);
  const cropped_out_frac = 1 - (artW * artH) / (width * height);
  return {
    data_url,
    bounds: { top, bottom, left, right },
    width,
    height,
    cropped_out_frac,
  };
}
