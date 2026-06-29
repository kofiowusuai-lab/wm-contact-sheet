// Auto-border-fix for freshly generated frames.
//
// Runs the existing detect-and-crop pipeline on a FAL-returned image URL
// BEFORE it's written to Blob, so a bordered frame never hits the timeline
// in the first place. Called from both the per-row generate flow and the
// end-to-end orchestrator.
//
// Zero generative cost — we reuse the same client-side canvas detection
// that the manual "Fix borders" bulk action uses. The trade-off: slight CPU
// time on the browser (one canvas decode + one matte scan per generate).
// In exchange, every persisted frame is guaranteed full-bleed.

import { cropAndUpscaleToFullBleed, detectBorderBounds } from './borderMask';

// Any matte detected above this fraction of total pixels triggers an auto
// crop. 1.5% handles tiny slivers (e.g. a 6-pixel white band at one edge)
// without bothering to re-encode frames that are already clean.
const AUTO_FIX_THRESHOLD = 0.015;

export type AutoFixResult = {
  fixed: boolean;
  /** When `fixed === true`, this is a JPEG data URL of the cropped + upscaled
   *  art. When `fixed === false`, it's the original URL (pass-through). */
  image: string;
  cropped_frac: number;
};

export async function autoFixBorders(imageUrl: string): Promise<AutoFixResult> {
  try {
    const { bounds, width, height } = await detectBorderBounds(imageUrl);
    const totalBorder =
      (bounds.top + bounds.bottom) * width + (bounds.left + bounds.right) * height;
    const totalPixels = width * height;
    const cropped_frac = totalBorder / totalPixels;

    if (cropped_frac < AUTO_FIX_THRESHOLD) {
      return { fixed: false, image: imageUrl, cropped_frac };
    }

    const { data_url, cropped_out_frac } = await cropAndUpscaleToFullBleed(imageUrl);
    return { fixed: true, image: data_url, cropped_frac: cropped_out_frac };
  } catch {
    // Canvas CORS or load failure — return the original untouched. The
    // downstream persist still succeeds; the user can run the manual "Fix
    // borders" action if the frame visibly has a matte.
    return { fixed: false, image: imageUrl, cropped_frac: 0 };
  }
}
