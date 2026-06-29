// Output aspect ratios for render + preview. Stored on ProjectMeta as a
// free-form string ('16:9' / '9:16' / '1:1' / '4:5') so future additions
// don't require a schema migration. Width/height are the actual pixel
// dimensions the renderer uses; picking them here keeps render, preview,
// and subtitle sizing in lockstep.

export type AspectId = '16:9' | '9:16' | '1:1' | '4:5';

export type AspectPreset = {
  id: AspectId;
  label: string;
  platforms: string;
  width: number;
  height: number;
  // Used for the CSS aspect-ratio property.
  cssRatio: string;
};

export const ASPECT_PRESETS: AspectPreset[] = [
  {
    id: '16:9',
    label: 'Landscape 16:9',
    platforms: 'YouTube · X',
    width: 1920,
    height: 1080,
    cssRatio: '16 / 9',
  },
  {
    id: '9:16',
    label: 'Vertical 9:16',
    platforms: 'Shorts · Reels · TikTok',
    width: 1080,
    height: 1920,
    cssRatio: '9 / 16',
  },
  {
    id: '1:1',
    label: 'Square 1:1',
    platforms: 'Instagram feed · X',
    width: 1080,
    height: 1080,
    cssRatio: '1 / 1',
  },
  {
    id: '4:5',
    label: 'Portrait 4:5',
    platforms: 'Instagram portrait',
    width: 1080,
    height: 1350,
    cssRatio: '4 / 5',
  },
];

export const DEFAULT_ASPECT: AspectId = '16:9';

export function resolveAspect(id: string | undefined): AspectPreset {
  return ASPECT_PRESETS.find((p) => p.id === id) ?? ASPECT_PRESETS[0];
}

// Per-segment aspect resolver. Prefer the segment's own stamp, then fall
// back to the project's current aspect (so frames rendered before the
// stamping feature existed display as the project aspect, not legacy
// 16:9), and only then to DEFAULT_ASPECT.
export function segmentAspect(
  seg: { aspect?: string } | null | undefined,
  projectAspect?: string,
): AspectId {
  const raw = seg?.aspect;
  if (raw && ASPECT_PRESETS.some((p) => p.id === raw)) return raw as AspectId;
  if (projectAspect && ASPECT_PRESETS.some((p) => p.id === projectAspect)) {
    return projectAspect as AspectId;
  }
  return DEFAULT_ASPECT;
}
