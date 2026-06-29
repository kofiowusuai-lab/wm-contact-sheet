'use client';

// Full-screen lightbox for browsing frames. Arrow keys / on-screen buttons
// navigate prev/next through the timeline; Esc closes.
//
// Two modes:
//  - Default: image centered, narration caption underneath, nav arrows + close.
//  - Editor mode: 3-column layout — Animation panel on the left, frame +
//    draggable caption + audio play button in the middle, Captions panel on
//    the right.

import { useEffect, useRef, useState } from 'react';
import type { Segment } from '../lib/blob';
import SubtitleOverlay, { isSubtitleEnabledFor, type SubtitleSettings, type WordTiming } from './SubtitleOverlay';
import FrameCaptionEditor from './FrameCaptionEditor';
import FrameAnimationPanel from './FrameAnimationPanel';
import SegmentAudioPreview from './SegmentAudioPreview';
import { setSegmentStyle, resolveCaptionStyle } from '../lib/captionStyle';
import { paginate, activePageIndex, type Page } from '../lib/subtitlePagination';
import { useIsMobile, useIsNarrowPhone } from '../lib/useMediaQuery';
import { colors, text } from './ui/tokens';

// Animations that emit one Dialogue per word; pagination is bypassed for
// these on the renderer side, so the browser preview must match.
const PER_WORD_ANIMATIONS = new Set<string>([
  'typewriter', 'typewriter_cursor', 'word_by_word',
  'karaoke', 'karaoke_fill', 'word_bounce', 'word_spring', 'word_flip',
  'word_rotate', 'pop', 'word_wave', 'word_glitch', 'bubble',
  'wave_color', 'tiktok_highlight', 'hopper',
]);

export default function Lightbox({
  projectId,
  segments,
  index,
  subtitles,
  voiceoverUrl,
  onSubtitlesChange,
  onKenBurnsChange,
  onClose,
  onPrev,
  onNext,
}: {
  projectId: string;
  segments: Segment[];
  index: number;
  subtitles?: SubtitleSettings;
  /** Project voiceover.mp3 URL so the lightbox can preview the audio window
   *  for the currently-viewed segment. Omit to hide the play button. */
  voiceoverUrl?: string | null;
  onSubtitlesChange?: (next: SubtitleSettings) => void;
  onKenBurnsChange?: (segId: string, kenBurns: string) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  // A single ref covers both <img> and <video> — we read clientWidth /
  // clientHeight and those exist on every HTMLElement, so the type is
  // broadened to avoid an impossible-to-satisfy union.
  const imgRef = useRef<HTMLElement>(null);
  const [imgHeight, setImgHeight] = useState(0);
  const [imgWidth, setImgWidth] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const isMobile = useIsMobile();
  const isNarrowPhone = useIsNarrowPhone();
  const [editorOpen, setEditorOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [wordsBySeg, setWordsBySeg] = useState<Record<string, WordTiming[]>>({});
  const wordsFetched = useRef(false);
  // Animation sync: bump playCue every time audio starts so the caption
  // overlay remounts + restarts its per-word CSS timeline in lock-step
  // with the actual audio playback. `animPlaying` then drives
  // animationPlayState inside SubtitleOverlay.
  const [playCue, setPlayCue] = useState(0);
  // Start running so the first paint of each segment auto-plays its
  // animations. Flips to paused when the user pauses audio; a subsequent
  // play both bumps playCue (remount → restart) and sets this back to true.
  const [animPlaying, setAnimPlaying] = useState(true);

  useEffect(() => {
    const update = () => {
      setImgHeight(imgRef.current?.clientHeight ?? 0);
      setImgWidth(imgRef.current?.clientWidth ?? 0);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [index, editorOpen]);

  // Segment change → reset the audio-sync state so the new segment auto-
  // plays its captions from t=0 instead of inheriting the previous
  // segment's "paused mid-animation" flag.
  useEffect(() => {
    setAnimPlaying(true);
    setPlayCue((c) => c + 1);
  }, [segments[index]?.id]);

  useEffect(() => {
    if (wordsFetched.current || !projectId) return;
    wordsFetched.current = true;
    (async () => {
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/words`);
        if (!r.ok) return;
        const j = await r.json();
        const allWords: WordTiming[] = Array.isArray(j?.words)
          ? j.words.map((w: any) => ({
              word: String(w.word || '').trim(),
              start: Number(w.start) || 0,
              end: Number(w.end) || 0,
            })).filter((w: WordTiming) => w.word.length > 0)
          : [];
        if (allWords.length === 0) return;
        const bySeg: Record<string, WordTiming[]> = {};
        for (const seg of segments) {
          if (!seg.narration) continue;
          const start = Number(seg.start) || 0;
          const end = Number(seg.end) || 0;
          const slice = allWords.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
          if (slice.length > 0) bySeg[seg.id] = slice;
        }
        setWordsBySeg(bySeg);
      } catch {
        // Non-fatal — fallback tokenisation in SubtitleOverlay covers us.
      }
    })();
  }, [projectId, segments]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    if (Math.abs(dx) > 50) {
      if (dx < 0) onNext();
      else onPrev();
    }
    touchStartX.current = null;
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editorOpen && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        if (editorOpen) setEditorOpen(false);
        else onClose();
      } else if (e.key === 'ArrowLeft') onPrev();
      else if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onPrev, onNext, editorOpen]);

  const seg = segments[index];
  if (!seg) return null;
  const total = segments.length;
  const prevDisabled = index <= 0;
  const nextDisabled = index >= total - 1;

  const navEdge = isNarrowPhone ? 6 : isMobile ? 10 : 16;
  const navBtnStyle = {
    ...styles.navBtn,
    ...(isMobile ? styles.navBtnMobile : null),
  };
  const captionBarStyle = {
    ...styles.caption,
    ...(isNarrowPhone ? styles.captionNarrow : null),
  };
  const narrationStyle = {
    ...styles.narration,
    ...(isNarrowPhone ? styles.narrationNarrow : null),
  };
  const wordsForSeg = wordsBySeg[seg.id];
  const captionsEnabled = subtitles && isSubtitleEnabledFor(seg.id, subtitles);

  // Audio playhead (absolute time within voiceover.mp3) — published by
  // SegmentAudioPreview's onTimeChange. Used to pick the active page when
  // pagination is on; otherwise unused.
  const [audioTime, setAudioTime] = useState<number>(Number(seg.start) || 0);
  // When the segment changes, snap to its start so the active page resets
  // to page 0 on segment navigation.
  useEffect(() => {
    setAudioTime(Number(seg.start) || 0);
  }, [seg.id, seg.start]);

  // Compute the displayed text — paginated when applicable.
  let displayedText = seg.narration ?? '';
  if (subtitles && captionsEnabled) {
    const resolved = resolveCaptionStyle(subtitles, seg.id);
    const animPerWord = PER_WORD_ANIMATIONS.has(resolved.animation);
    if (resolved.paginationEnabled && !animPerWord) {
      const segStart = Number(seg.start) || 0;
      const segEnd = Math.max(Number(seg.end) || 0, segStart + 0.4);
      const maxLines = subtitles.singleLine ? 1 : resolved.maxLines;
      const pages: Page[] = paginate(
        seg.narration ?? '',
        wordsForSeg ?? null,
        segStart,
        segEnd,
        { maxLines, maxCharsPerLine: resolved.maxCharsPerLine },
      );
      if (pages.length > 0) {
        const idx = activePageIndex(pages, audioTime);
        const pick = pages[idx >= 0 ? idx : 0];
        displayedText = pick.lines.join('\n');
      }
    }
  }

  // Center area: image + overlay + audio preview. Shared between both layouts.
  const centerContent = (
    <div
      style={editorOpen ? styles.centerEditor : styles.frameWrap}
      onClick={(e) => e.stopPropagation()}
    >
      {seg.frame_url ? (
        <div
          style={{
            position: 'relative',
            display: 'inline-block',
            maxWidth: editorOpen ? '100%' : '92vw',
            maxHeight: editorOpen ? '72vh' : '78vh',
          }}
        >
          {seg.is_video ? (
            <video
              // Seedance-generated mp4s — autoplay/loop/muted so the tile
              // plays inline in the preview. Seedance clips include audio
              // but we mute it here because SegmentAudioPreview already
              // plays the project voiceover windowed to this segment.
              ref={imgRef as React.RefObject<HTMLVideoElement>}
              src={seg.frame_url}
              autoPlay
              loop
              muted
              playsInline
              style={{
                ...styles.image,
                maxWidth: editorOpen ? '100%' : '90vw',
                maxHeight: editorOpen ? '72vh' : '80vh',
              }}
              onLoadedMetadata={() => {
                setImgHeight((imgRef.current as HTMLVideoElement | null)?.clientHeight ?? 0);
                setImgWidth((imgRef.current as HTMLVideoElement | null)?.clientWidth ?? 0);
              }}
            />
          ) : (
            <img
              ref={imgRef as React.RefObject<HTMLImageElement>}
              src={seg.frame_url}
              alt={seg.id}
              style={{
                ...styles.image,
                maxWidth: editorOpen ? '100%' : '90vw',
                maxHeight: editorOpen ? '72vh' : '80vh',
              }}
              onLoad={() => {
                setImgHeight((imgRef.current as HTMLImageElement | null)?.clientHeight ?? 0);
                setImgWidth((imgRef.current as HTMLImageElement | null)?.clientWidth ?? 0);
              }}
            />
          )}
          {subtitles && imgHeight > 0 && captionsEnabled && (
            <SubtitleOverlay
              // Include playCue so every audio-play restarts the CSS
              // animations at t=0 coincident with the audio's first frame.
              key={`${seg.id}-${playCue}-${JSON.stringify(subtitles.segmentStyles?.[seg.id] ?? null)}`}
              text={displayedText}
              settings={subtitles}
              frameHeight={imgHeight}
              frameWidth={imgWidth}
              segId={seg.id}
              words={wordsForSeg}
              segStart={Number(seg.start) || 0}
              segDuration={Math.max(0.4, (Number(seg.end) || 0) - (Number(seg.start) || 0))}
              animPlaying={animPlaying}
              draggable={editorOpen}
              onDragChange={setDragging}
              onOffsetChange={(dx, dy) => {
                if (!onSubtitlesChange || !subtitles) return;
                onSubtitlesChange(
                  setSegmentStyle(subtitles, seg.id, { offsetXPct: dx, offsetYPct: dy }),
                );
              }}
            />
          )}
          {dragging && imgWidth > 0 && imgHeight > 0 && subtitles && (() => {
            const res = resolveCaptionStyle(subtitles, seg.id);
            const snappedX = Math.abs(res.offsetXPct) < 0.05;
            const snappedY = Math.abs(res.offsetYPct) < 0.05;
            return (
              <>
                <div
                  style={{
                    position: 'absolute',
                    top: 0, bottom: 0, left: '50%',
                    width: 1,
                    transform: 'translateX(-0.5px)',
                    background: snappedX ? 'rgba(79, 70, 229, 0.85)' : 'rgba(255,255,255,0.45)',
                    boxShadow: snappedX ? '0 0 6px rgba(79, 70, 229, 0.9)' : undefined,
                    pointerEvents: 'none',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: 0, right: 0, top: '50%',
                    height: 1,
                    transform: 'translateY(-0.5px)',
                    background: snappedY ? 'rgba(79, 70, 229, 0.85)' : 'rgba(255,255,255,0.45)',
                    boxShadow: snappedY ? '0 0 6px rgba(79, 70, 229, 0.9)' : undefined,
                    pointerEvents: 'none',
                  }}
                />
                {snappedX && snappedY && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '50%', left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 18, height: 18, borderRadius: '50%',
                      border: '2px solid rgba(79, 70, 229, 0.95)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </>
            );
          })()}
        </div>
      ) : (
        <div style={styles.placeholder}>no frame yet for {seg.id}</div>
      )}

      {/* Audio preview — segment window */}
      {voiceoverUrl && (
        <div style={{ marginTop: 12, width: '100%', maxWidth: 520 }}>
          <SegmentAudioPreview
            voiceoverUrl={voiceoverUrl}
            start={Number(seg.start) || 0}
            end={Math.max(Number(seg.end) || 0, (Number(seg.start) || 0) + 0.3)}
            cue={seg.id}
            onPlayStart={() => {
              setPlayCue((c) => c + 1);
              setAnimPlaying(true);
            }}
            onPlayStop={() => setAnimPlaying(false)}
            onTimeChange={setAudioTime}
          />
        </div>
      )}

      <div style={captionBarStyle}>
        <div style={styles.captionMeta}>
          <span style={styles.segId}>{seg.id}</span>
          <span style={styles.position}>
            {index + 1} / {total}
          </span>
        </div>
        <span style={narrationStyle}>{seg.narration}</span>
      </div>
    </div>
  );

  return (
    <div
      style={{ ...styles.overlay, ...(isMobile ? styles.overlayMobile : null) }}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {editorOpen && onSubtitlesChange && subtitles ? (
        // --- Full-panel editor layout ---
        <div style={styles.threeCol} onClick={(e) => e.stopPropagation()}>
          <aside style={{ ...styles.sidePanel, ...styles.sidePanelLeft }}>
            <div style={styles.sideHead}>
              <div style={styles.sideTitle}>Animations — {seg.id}</div>
            </div>
            <FrameAnimationPanel
              segId={seg.id}
              settings={subtitles}
              onChange={onSubtitlesChange}
              onClose={() => setEditorOpen(false)}
              kenBurns={seg.ken_burns}
              onKenBurnsChange={
                onKenBurnsChange
                  ? (next) => onKenBurnsChange(seg.id, next)
                  : undefined
              }
            />
          </aside>

          <main style={styles.centerColumn}>
            {centerContent}
          </main>

          <aside style={{ ...styles.sidePanel, ...styles.sidePanelRight }}>
            <div style={styles.sideHead}>
              <div style={styles.sideTitle}>Captions — {seg.id}</div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                style={styles.sideClose}
                aria-label="Close editor"
              >
                ×
              </button>
            </div>
            <FrameCaptionEditor
              segId={seg.id}
              settings={subtitles}
              onChange={onSubtitlesChange}
            />
          </aside>
        </div>
      ) : (
        // --- Default preview layout ---
        centerContent
      )}

      {!editorOpen && (
        <>
          <button
            style={{ ...navBtnStyle, left: navEdge, opacity: prevDisabled ? 0.3 : 1 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!prevDisabled) onPrev();
            }}
            disabled={prevDisabled}
            title="Previous (←)"
          >
            ‹
          </button>
          <button
            style={{ ...navBtnStyle, right: navEdge, opacity: nextDisabled ? 0.3 : 1 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!nextDisabled) onNext();
            }}
            disabled={nextDisabled}
            title="Next (→)"
          >
            ›
          </button>
        </>
      )}

      {onSubtitlesChange && subtitles && !editorOpen && (
        <button
          style={{
            ...styles.captionsBtn,
            ...(isMobile ? styles.captionsBtnMobile : null),
          }}
          onClick={(e) => {
            e.stopPropagation();
            setEditorOpen(true);
          }}
          title="Edit captions + animations for this frame"
        >
          ✏️ Captions
        </button>
      )}

      {!editorOpen && (
        <button
          style={{ ...styles.closeBtn, ...(isMobile ? styles.closeBtnMobile : null) }}
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.92)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  overlayMobile: { padding: 8 },
  frameWrap: {
    maxWidth: '90vw',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  threeCol: {
    display: 'flex',
    width: '100%',
    height: '100%',
    gap: 16,
    alignItems: 'stretch',
    justifyContent: 'stretch',
  },
  sidePanel: {
    width: 340,
    flexShrink: 0,
    background: colors.bg.raised,
    border: `1px solid ${colors.border.default}`,
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.55)',
  },
  sidePanelLeft: {},
  sidePanelRight: {},
  sideHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: `1px solid ${colors.border.subtle}`,
  },
  sideTitle: { ...text.h3, color: colors.text.primary },
  sideClose: {
    background: 'transparent',
    border: 'none',
    color: colors.text.secondary,
    fontSize: 22,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 4,
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerEditor: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  image: {
    maxWidth: '90vw',
    maxHeight: '80vh',
    objectFit: 'contain',
    borderRadius: 8,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
  },
  placeholder: {
    width: '60vw',
    height: '40vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a0a0a',
    border: '1px dashed #404040',
    borderRadius: 8,
    color: '#737373',
    fontSize: 14,
  },
  caption: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    color: '#e2e8f0',
    fontSize: 13,
    padding: '8px 14px',
    background: 'rgba(23, 23, 23, 0.85)',
    borderRadius: 6,
    maxWidth: '92vw',
  },
  captionNarrow: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '8px 10px',
    fontSize: 12,
    width: '92vw',
  },
  captionMeta: { display: 'flex', gap: 10, alignItems: 'center' },
  segId: { color: '#60a5fa', fontWeight: 600, fontFamily: 'monospace' },
  position: { color: '#737373', fontFamily: 'monospace' },
  narration: { color: '#e5e5e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  narrationNarrow: {
    whiteSpace: 'normal',
    overflow: 'visible',
    textOverflow: 'clip',
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
  },
  navBtn: {
    position: 'fixed',
    top: '50%',
    transform: 'translateY(-50%)',
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: 'rgba(38, 38, 38, 0.85)',
    border: '1px solid #404040',
    color: '#f5f5f5',
    fontSize: 32,
    lineHeight: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    userSelect: 'none',
    zIndex: 1001,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    touchAction: 'manipulation',
  },
  navBtnMobile: { width: 44, height: 44, fontSize: 26 },
  closeBtn: {
    position: 'fixed',
    top: 16,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'rgba(38, 38, 38, 0.85)',
    border: '1px solid #404040',
    color: '#f5f5f5',
    fontSize: 18,
    cursor: 'pointer',
    zIndex: 1001,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    touchAction: 'manipulation',
  },
  closeBtnMobile: { top: 10, right: 10, width: 40, height: 40 },
  captionsBtn: {
    position: 'fixed',
    bottom: 24,
    right: 24,
    padding: '10px 18px',
    borderRadius: 999,
    background: 'rgba(38, 38, 38, 0.9)',
    border: '1px solid #404040',
    color: '#f5f5f5',
    fontSize: 14,
    fontFamily: 'inherit',
    cursor: 'pointer',
    zIndex: 1002,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  captionsBtnMobile: { bottom: 16, right: 16, padding: '8px 14px', fontSize: 13 },
};
