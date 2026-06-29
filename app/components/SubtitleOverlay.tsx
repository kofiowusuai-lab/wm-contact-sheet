'use client';

// Renders a subtitle block positioned over a frame. Scale-invariant: font
// size is a fraction of the min(frameW, frameH) so the same settings look
// correct on a 280×158 thumbnail and on a full-screen lightbox image.
//
// v2: per-segment style overrides + three CapCut-style animations.
// Resolver lives in app/lib/captionStyle.ts; keep parity with the Python
// renderer (scripts/render_from_supabase.py::_build_ass) any time this
// file changes.

import { DEFAULT_SUBTITLE_FONT, fontFamilyStack } from '../lib/subtitleFonts';
import { resolveCaptionStyle, type SegmentCaptionStyle, type CaptionAnimation } from '../lib/captionStyle';
import { ANIMATIONS_BY_ID } from '../lib/captionAnimations';

export type { CaptionAnimation, SegmentCaptionStyle };

export type WordTiming = { word: string; start: number; end: number };

export type SubtitleSettings = {
  enabled: boolean;
  fontSizeRatio: number;
  vAlign: 'top' | 'middle' | 'bottom';
  hAlign: 'left' | 'center' | 'right';
  color: string;
  background: string;
  showBackground: boolean;
  singleLine: boolean;
  fontFamily: string;
  disabledIds: string[];
  // v2 — all optional, missing on pre-existing projects
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlightColor?: string;
  animation?: CaptionAnimation;
  animationSpeed?: number;
  offsetXPct?: number;
  offsetYPct?: number;
  segmentStyles?: Record<string, SegmentCaptionStyle>;
  // Pagination — opt-in. When true, long narrations are split into pages of
  // at most `maxLines` lines and auto-advance within the segment's window.
  // See app/lib/subtitlePagination.ts.
  paginationEnabled?: boolean;
  maxLines?: number;          // 1..4 (clamped)
  maxCharsPerLine?: number;   // 16..80 (clamped)
};

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  enabled: false,
  fontSizeRatio: 0.09,
  vAlign: 'bottom',
  hAlign: 'center',
  color: '#ffffff',
  background: 'rgba(0, 0, 0, 0.55)',
  showBackground: true,
  singleLine: false,
  fontFamily: DEFAULT_SUBTITLE_FONT,
  disabledIds: [],
  bold: false,
  italic: false,
  underline: false,
  highlightColor: '#ffde59',
  animation: 'none',
  animationSpeed: 1,
  offsetXPct: 0,
  offsetYPct: 0,
  segmentStyles: {},
  paginationEnabled: false,
  maxLines: 2,
  maxCharsPerLine: 38,
};

export function isSubtitleEnabledFor(segId: string, settings: SubtitleSettings): boolean {
  return settings.enabled && !settings.disabledIds.includes(segId);
}

type Props = {
  text: string;
  settings: SubtitleSettings;
  frameHeight: number;
  frameWidth?: number;
  segId?: string;
  /** Per-segment slice of words.json (optional; required for word-level
   *  animations — falls back to simple split-by-spaces when missing). */
  words?: WordTiming[];
  /** Segment start time in seconds (for mapping word timings to relative
   *  CSS animation delays). Defaults to 0 if missing. */
  segStart?: number;
  /** Total segment duration in seconds (for typewriter timing). */
  segDuration?: number;
  /** When true, the caption block is draggable. Parent supplies
   *  onOffsetChange to receive the new `offsetXPct` / `offsetYPct` values
   *  in response. onDragChange toggles centre-guide visibility. */
  draggable?: boolean;
  onOffsetChange?: (offsetXPct: number, offsetYPct: number) => void;
  onDragChange?: (dragging: boolean) => void;
  /** Audio-sync: set to `false` to pause every running CSS animation on
   *  the caption block (word spans included). Default is `true` — the
   *  legacy "always-run" behaviour. Combine with a React `key` bump on
   *  audio-play to restart per-word timelines coincident with playback. */
  animPlaying?: boolean;
};

export default function SubtitleOverlay({
  text,
  settings,
  frameHeight,
  frameWidth,
  segId,
  words,
  segStart = 0,
  segDuration,
  draggable,
  onOffsetChange,
  onDragChange,
  animPlaying = true,
}: Props) {
  if (!settings.enabled || !text) return null;

  const style = resolveCaptionStyle(settings, segId);

  const scaleDim =
    frameWidth && frameWidth > 0 ? Math.min(frameWidth, frameHeight) : frameHeight;
  const fontPx = Math.max(8, Math.round(scaleDim * style.sizeRatio));
  const padY = settings.showBackground ? Math.max(2, Math.round(fontPx * 0.3)) : 0;
  const padX = settings.showBackground ? Math.max(4, Math.round(fontPx * 0.6)) : 0;
  const margin = Math.max(6, Math.round(scaleDim * 0.04));
  const strokePx = Math.max(1, Math.round(fontPx * 0.08));

  // --- Positioning: anchor from vAlign/hAlign + percent offset fine-tune ---
  const pos: React.CSSProperties = { position: 'absolute' };
  const dx = (style.offsetXPct ?? 0) / 100;
  const dy = (style.offsetYPct ?? 0) / 100;

  if (style.vAlign === 'top') {
    pos.top = `calc(${margin}px + ${dy * 100}%)`;
  } else if (style.vAlign === 'middle') {
    pos.top = `calc(50% + ${dy * 100}%)`;
  } else {
    pos.bottom = `calc(${margin}px - ${dy * 100}%)`;
  }
  if (style.hAlign === 'left') {
    pos.left = `calc(${margin}px + ${dx * 100}%)`;
  } else if (style.hAlign === 'right') {
    pos.right = `calc(${margin}px - ${dx * 100}%)`;
  } else {
    pos.left = `calc(50% + ${dx * 100}%)`;
  }
  const translateX = style.hAlign === 'center' ? '-50%' : '0';
  const translateY = style.vAlign === 'middle' ? '-50%' : '0';
  pos.transform = translateX !== '0' || translateY !== '0'
    ? `translate(${translateX}, ${translateY})`
    : undefined;

  const baseText: React.CSSProperties = {
    maxWidth: settings.singleLine ? 'none' : '90%',
    padding: `${padY}px ${padX}px`,
    fontSize: fontPx,
    lineHeight: 1.2,
    color: style.color,
    background: settings.showBackground ? settings.background : 'transparent',
    borderRadius: settings.showBackground ? Math.round(fontPx * 0.2) : 0,
    textAlign:
      style.hAlign === 'left' ? 'left' : style.hAlign === 'right' ? 'right' : 'center',
    fontWeight: style.bold ? 900 : 800,
    fontStyle: style.italic ? 'italic' : 'normal',
    textDecoration: style.underline ? 'underline' : 'none',
    fontFamily: fontFamilyStack(style.fontFamily),
    pointerEvents: draggable ? 'auto' : 'none',
    cursor: draggable ? 'grab' : 'default',
    touchAction: draggable ? 'none' : undefined,
    userSelect: draggable ? 'none' : undefined,
    WebkitTextStroke: settings.showBackground ? undefined : `${strokePx}px #000`,
    textShadow: settings.showBackground
      ? '0 1px 2px rgba(0, 0, 0, 0.8)'
      : '0 2px 6px rgba(0, 0, 0, 0.6)',
    paintOrder: 'stroke fill',
    // pre-line preserves explicit `\n` line breaks (used by paginated text)
    // while still collapsing other whitespace and wrapping at word edges.
    whiteSpace: settings.singleLine ? 'nowrap' : 'pre-line',
    wordBreak: settings.singleLine ? 'normal' : 'break-word',
  };

  // Pointer handlers — activate only when draggable. Parent receives
  // offset updates expressed as % of frame width/height, with a ±3%
  // snap-to-zero window that feels like a gentle magnet when you hover
  // near the image centre.
  const onPointerDown = draggable
    ? (e: React.PointerEvent<HTMLDivElement>) => {
        if (!frameWidth || !frameHeight) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget as HTMLDivElement;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const startOffX = style.offsetXPct;
        const startOffY = style.offsetYPct;
        onDragChange?.(true);
        el.style.cursor = 'grabbing';

        const SNAP_PCT = 3;
        const handleMove = (ev: PointerEvent) => {
          const dxPx = ev.clientX - startX;
          const dyPx = ev.clientY - startY;
          let newX = startOffX + (dxPx / frameWidth) * 100;
          let newY = startOffY + (dyPx / frameHeight) * 100;
          // Clamp to a reasonable range.
          newX = Math.max(-40, Math.min(40, newX));
          newY = Math.max(-40, Math.min(40, newY));
          // Snap to 0 within the tolerance window.
          if (Math.abs(newX) < SNAP_PCT) newX = 0;
          if (Math.abs(newY) < SNAP_PCT) newY = 0;
          onOffsetChange?.(newX, newY);
        };
        const handleUp = () => {
          try { el.releasePointerCapture(e.pointerId); } catch {}
          el.style.cursor = 'grab';
          window.removeEventListener('pointermove', handleMove);
          window.removeEventListener('pointerup', handleUp);
          window.removeEventListener('pointercancel', handleUp);
          onDragChange?.(false);
        };
        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleUp);
      }
    : undefined;

  // --- Animation: registry-driven dispatch ---
  const speed = Math.max(0.25, Math.min(4, style.animationSpeed || 1));
  const def = ANIMATIONS_BY_ID[style.animation];
  const hlVar = { ['--hl' as any]: style.highlightColor } as React.CSSProperties;

  // No animation OR unknown id → plain static overlay.
  if (!def || def.id === 'none' || !def.cssName) {
    return <div onPointerDown={onPointerDown} style={{ ...pos, ...baseText, ...hlVar }}>{text}</div>;
  }

  // Typewriter is block-kind but needs a special mask + char steps.
  if (def.id === 'typewriter' || def.id === 'typewriter_cursor') {
    const dur = Math.min(segDuration ?? 2.5, 3) / speed;
    const withCursor = def.id === 'typewriter_cursor';
    return (
      <div
        onPointerDown={onPointerDown}
        style={{
          ...pos,
          ...baseText,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          animation: `wm-cap-typewriter ${dur}s steps(${Math.max(8, text.length)}, end) both`,
          borderRight: withCursor ? '0.12em solid currentColor' : undefined,
          animationName: withCursor ? 'wm-cap-typewriter, wm-cap-typewriter-caret' : 'wm-cap-typewriter',
          animationDuration: withCursor ? `${dur}s, 0.8s` : `${dur}s`,
          animationTimingFunction: withCursor ? `steps(${Math.max(8, text.length)}, end), steps(2, end)` : `steps(${Math.max(8, text.length)}, end)`,
          animationIterationCount: withCursor ? '1, infinite' : '1',
          animationFillMode: 'both',
          animationPlayState: animPlaying ? 'running' : 'paused',
        }}
      >
        {text}
      </div>
    );
  }

  // Block-level animations — one keyframe on the outer div.
  if (def.kind === 'block') {
    const base = def.base ?? 0.5;
    const dur = Math.max(0.2, base * (def.loop ? 1 : 1) / speed);
    const iter = def.loop ? 'infinite' : '1';
    // Gradient sweep needs a text-gradient-clip backdrop.
    const extra: React.CSSProperties = def.id === 'gradient_sweep'
      ? {
          backgroundImage: `linear-gradient(90deg, ${style.color} 0%, ${style.highlightColor} 50%, ${style.color} 100%)`,
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }
      : {};
    return (
      <div
        onPointerDown={onPointerDown}
        style={{
          ...pos,
          ...baseText,
          ...extra,
          ...hlVar,
          animation: `${def.cssName} ${dur}s ${def.timing ?? 'ease-out'} ${iter} both`,
          animationPlayState: animPlaying ? 'running' : 'paused',
        }}
      >
        {text}
      </div>
    );
  }

  // Per-word animations — split into spans, stagger each by its Whisper
  // start-time (or an even split when words.json is missing).
  const tokens = (words && words.length > 0)
    ? words
    : splitIntoTokens(text, segStart, segDuration ?? 2);
  return (
    <div onPointerDown={onPointerDown} style={{ ...pos, ...baseText, ...hlVar }}>
      {tokens.map((w, i) => {
        const delay = Math.max(0, (w.start - segStart) / speed);
        const dur = Math.max(0.2, (w.end - w.start) / speed);
        // TikTok highlight needs per-span padding to make the pill look
        // right; bubble + wave-color use inline-block spacing.
        const spanExtra: React.CSSProperties =
          def.id === 'tiktok_highlight'
            ? { padding: '0 0.25em', borderRadius: '0.2em' }
            : {};
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              margin: '0 0.18em',
              animation: `${def.cssName} ${dur.toFixed(2)}s ${delay.toFixed(2)}s ${def.timing ?? 'ease-out'} both`,
              animationPlayState: animPlaying ? 'running' : 'paused',
              opacity: 0,
              ...spanExtra,
            }}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
}

// Fallback when words.json is missing: split the narration by whitespace
// and divide the segment's duration evenly across tokens.
function splitIntoTokens(text: string, start: number, duration: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const step = Math.max(0.12, duration / words.length);
  return words.map((w, i) => ({
    word: w,
    start: start + i * step,
    end: start + (i + 1) * step,
  }));
}
