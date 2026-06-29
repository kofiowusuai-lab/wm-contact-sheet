// Per-segment caption style + animation overlay types.
//
// Keep this file AS LEAN AS POSSIBLE — every field declared here is also
// read by scripts/render_from_supabase.py on the Python side, so the two
// have to stay in lockstep. If you add a field, add the ASS-side mapping
// in _build_ass() at the same time.

import type { SubtitleSettings } from '../components/SubtitleOverlay';
import type { CaptionAnimationId } from './captionAnimations';

export type CaptionAnimation = CaptionAnimationId;

export type SegmentCaptionStyle = {
  fontFamily?: string;
  color?: string;
  size?: number;              // ratio override, trumps global fontSizeRatio
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlightColor?: string;    // used by word_by_word + pop animations
  animation?: CaptionAnimation;
  animationSpeed?: number;    // 0.5 = slow, 1 = default, 2 = fast
  vAlign?: 'top' | 'middle' | 'bottom';
  hAlign?: 'left' | 'center' | 'right';
  offsetXPct?: number;        // -40..+40
  offsetYPct?: number;        // -40..+40
  // Pagination overrides (per-segment). Resolved against global defaults.
  paginationEnabled?: boolean;
  maxLines?: number;          // 1..4
  maxCharsPerLine?: number;   // 16..80
};

/** Shape returned by resolveCaptionStyle — fully populated, ready to render. */
export type ResolvedCaption = {
  fontFamily: string;
  color: string;
  sizeRatio: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  highlightColor: string;
  animation: CaptionAnimation;
  animationSpeed: number;
  vAlign: 'top' | 'middle' | 'bottom';
  hAlign: 'left' | 'center' | 'right';
  offsetXPct: number;
  offsetYPct: number;
  paginationEnabled: boolean;
  maxLines: number;
  maxCharsPerLine: number;
};

/**
 * Merge global SubtitleSettings with an optional per-segment override. The
 * per-segment override always wins when present.
 */
export function resolveCaptionStyle(
  settings: SubtitleSettings,
  segId?: string,
): ResolvedCaption {
  const seg = segId ? settings.segmentStyles?.[segId] : undefined;
  const pick = <T,>(o: T | undefined, g: T): T => (o !== undefined ? o : g);
  return {
    fontFamily: pick(seg?.fontFamily, settings.fontFamily),
    color: pick(seg?.color, settings.color),
    sizeRatio: pick(seg?.size, settings.fontSizeRatio),
    bold: pick(seg?.bold, settings.bold ?? false),
    italic: pick(seg?.italic, settings.italic ?? false),
    underline: pick(seg?.underline, settings.underline ?? false),
    highlightColor: pick(seg?.highlightColor, settings.highlightColor ?? '#ffde59'),
    animation: pick(seg?.animation, settings.animation ?? 'none'),
    animationSpeed: pick(seg?.animationSpeed, settings.animationSpeed ?? 1),
    vAlign: pick(seg?.vAlign, settings.vAlign),
    hAlign: pick(seg?.hAlign, settings.hAlign),
    offsetXPct: pick(seg?.offsetXPct, settings.offsetXPct ?? 0),
    offsetYPct: pick(seg?.offsetYPct, settings.offsetYPct ?? 0),
    paginationEnabled: pick(seg?.paginationEnabled, settings.paginationEnabled ?? false),
    maxLines: pick(seg?.maxLines, settings.maxLines ?? 2),
    maxCharsPerLine: pick(seg?.maxCharsPerLine, settings.maxCharsPerLine ?? 38),
  };
}

/** Update helpers that preserve the overlay spec invariants. */
export function setSegmentStyle(
  settings: SubtitleSettings,
  segId: string,
  patch: Partial<SegmentCaptionStyle>,
): SubtitleSettings {
  const current = settings.segmentStyles?.[segId] ?? {};
  const merged: SegmentCaptionStyle = { ...current, ...patch };
  // Drop empty objects so the persisted JSON stays clean.
  const hasAny = Object.values(merged).some((v) => v !== undefined);
  const next = { ...(settings.segmentStyles ?? {}) };
  if (hasAny) next[segId] = merged;
  else delete next[segId];
  return { ...settings, segmentStyles: next };
}

export function clearSegmentStyle(
  settings: SubtitleSettings,
  segId: string,
): SubtitleSettings {
  if (!settings.segmentStyles || !settings.segmentStyles[segId]) return settings;
  const next = { ...settings.segmentStyles };
  delete next[segId];
  return { ...settings, segmentStyles: next };
}

/**
 * "Apply to all frames" — copy the resolved style from one segment up into
 * the top-level defaults, then drop every per-segment override so the whole
 * project inherits the same look.
 */
export function applyStyleToAllSegments(
  settings: SubtitleSettings,
  sourceSegId: string,
): SubtitleSettings {
  const r = resolveCaptionStyle(settings, sourceSegId);
  return {
    ...settings,
    fontFamily: r.fontFamily,
    color: r.color,
    fontSizeRatio: r.sizeRatio,
    bold: r.bold,
    italic: r.italic,
    underline: r.underline,
    highlightColor: r.highlightColor,
    animation: r.animation,
    animationSpeed: r.animationSpeed,
    vAlign: r.vAlign,
    hAlign: r.hAlign,
    offsetXPct: r.offsetXPct,
    offsetYPct: r.offsetYPct,
    paginationEnabled: r.paginationEnabled,
    maxLines: r.maxLines,
    maxCharsPerLine: r.maxCharsPerLine,
    segmentStyles: {},
  };
}
