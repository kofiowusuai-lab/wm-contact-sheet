'use client';

// YouTube-style browser-side preview. A single <audio> element (hidden) drives
// playback; the video stage mirrors the active frame and Ken Burns motion
// synced to audio.currentTime; a custom control bar overlays the bottom of
// the stage with play / scrub / time / volume / fullscreen.
//
// Uses the SAME gap-coverage rule as the renderer — each segment's on-screen
// end is the next segment's start, and the last segment extends to the audio
// duration — so what plays here matches what render will produce.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment } from '../lib/blob';
import SubtitleOverlay, { isSubtitleEnabledFor, type SubtitleSettings, type WordTiming } from './SubtitleOverlay';
import { useIsMobile } from '../lib/useMediaQuery';
import { parseKenBurns, getTransformPair } from '../lib/kenBurns';
import { resolveAspect } from '../lib/aspectRatios';
import { resolveCaptionStyle } from '../lib/captionStyle';
import { paginate, activePageIndex, type Page } from '../lib/subtitlePagination';

// Animations that emit one Dialogue per word; pagination is bypassed for
// these on the renderer side, so the browser preview must match.
const PER_WORD_ANIMATIONS = new Set<string>([
  'typewriter', 'typewriter_cursor', 'word_by_word',
  'karaoke', 'karaoke_fill', 'word_bounce', 'word_spring', 'word_flip',
  'word_rotate', 'pop', 'word_wave', 'word_glitch', 'bubble',
  'wave_color', 'tiktok_highlight', 'hopper',
]);

const COLLAPSE_KEY = 'wm_preview_open';

function fmtTs(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function PreviewPlayer({
  projectId,
  segments,
  voiceoverUrl,
  subtitles,
  aspect,
}: {
  projectId?: string;
  segments: Segment[];
  voiceoverUrl: string | null;
  subtitles?: SubtitleSettings;
  aspect?: string;
}) {
  const aspectPreset = resolveAspect(aspect);
  const [open, setOpen] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [frameHeightPx, setFrameHeightPx] = useState(0);
  const [frameWidthPx, setFrameWidthPx] = useState(0);
  const isMobile = useIsMobile();

  // Restore collapse state across refreshes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw === 'closed') setOpen(false);
    } catch {}
  }, []);
  const toggleOpen = useCallback(() => {
    setOpen((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, !v ? 'open' : 'closed');
      } catch {}
      return !v;
    });
  }, []);

  // Measure frame height AND width so the subtitle overlay scales off the
  // shorter dimension — critical for 9:16 where height-based scaling alone
  // produces subtitle text too large for the narrow width.
  useEffect(() => {
    const update = () => {
      if (frameRef.current) {
        setFrameHeightPx(frameRef.current.clientHeight);
        setFrameWidthPx(frameRef.current.clientWidth);
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, isMobile, fullscreen]);

  // Per-segment display-end: next segment's start, or audio duration for the
  // tail. Identical to render_from_supabase.py's gap-aware logic.
  const displayEnds = useMemo(() => {
    return segments.map((s, i) => {
      if (i < segments.length - 1) return segments[i + 1].start;
      return Math.max(audioDuration, s.end);
    });
  }, [segments, audioDuration]);

  // Fetch words.json once per project for browser-side pagination timing.
  // Lifted from Lightbox's pattern. Pagination falls back to even-divide
  // when this is empty (the algorithm handles words=null).
  const [wordsBySeg, setWordsBySeg] = useState<Record<string, WordTiming[]>>({});
  const wordsFetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !subtitles?.paginationEnabled) return;
    if (wordsFetchedFor.current === projectId) return;
    wordsFetchedFor.current = projectId;
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
          const slice = allWords.filter(
            (w) => w.start >= start - 0.05 && w.end <= end + 0.05,
          );
          if (slice.length > 0) bySeg[seg.id] = slice;
        }
        setWordsBySeg(bySeg);
      } catch {
        // Non-fatal: paginate() falls back to character-weighted divide.
      }
    })();
  }, [projectId, subtitles?.paginationEnabled, segments]);

  const totalDuration = audioDuration || displayEnds[displayEnds.length - 1] || 0;

  // rAF loop while playing keeps currentTime smooth (native 'timeupdate'
  // fires ~4×/sec — too jittery for frame-transition detection).
  useEffect(() => {
    if (!playing || !audioRef.current) return;
    let raf = 0;
    const tick = () => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => setAudioDuration(a.duration || 0);
    const onTime = () => setCurrentTime(a.currentTime);
    const onEnd = () => setPlaying(false);
    const onVol = () => {
      setVolume(a.volume);
      setMuted(a.muted);
    };
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    a.addEventListener('ended', onEnd);
    a.addEventListener('volumechange', onVol);
    return () => {
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onTime);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('volumechange', onVol);
    };
  }, [voiceoverUrl]);

  // Fullscreen state sync — user may exit via Esc.
  useEffect(() => {
    const onFsChange = () => {
      setFullscreen(document.fullscreenElement === stageRef.current);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Auto-hide controls after 2.5s of no movement, only while playing. Show
  // immediately on mousemove / touch / pause.
  const nudgeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (audioRef.current && !audioRef.current.paused) {
        setControlsVisible(false);
      }
    }, 2500);
  }, []);
  useEffect(() => {
    if (!playing) {
      setControlsVisible(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    } else {
      nudgeControls();
    }
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [playing, nudgeControls]);

  const [audioError, setAudioError] = useState<string | null>(null);
  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      // Force unmuted + full volume before play. Some browsers (and some
      // OS-level media handlers) retain a previous muted state across
      // audio element re-creations even though React state says otherwise.
      a.muted = false;
      if (a.volume === 0) a.volume = 1;
      setAudioError(null);
      a.play().catch((err: any) => {
        const msg = String(err?.message || err || 'play() rejected');
        console.error('[PreviewPlayer] audio play failed', err);
        setAudioError(msg.slice(0, 140));
      });
    } else {
      a.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.muted = !a.muted;
  }, []);

  const setAudioVolume = useCallback((v: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, v));
    if (a.muted && v > 0) a.muted = false;
  }, []);

  const seekTo = useCallback((t: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(totalDuration, t));
  }, [totalDuration]);

  const onProgressPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(frac * totalDuration);
  }, [seekTo, totalDuration]);

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      // ignore — some browsers refuse without user gesture chains
    }
  }, []);

  // Space / K toggles play, F toggles fullscreen, M toggles mute, arrows seek.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (!stageRef.current) return;
      const target = e.target as HTMLElement | null;
      // Don't hijack typing inside inputs / textareas.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      // Only respond when the preview is in the foreground (fullscreen) OR
      // the stage is within viewport. Simple heuristic: if fullscreen, yes.
      // Otherwise require focus within the player.
      if (!fullscreen && !stageRef.current.contains(document.activeElement)) return;
      if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekTo(currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekTo(currentTime - 5);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, fullscreen, togglePlay, toggleFullscreen, toggleMute, seekTo, currentTime]);

  // Which segment is on screen right now?
  const activeIdx = useMemo(() => {
    if (segments.length === 0) return -1;
    if (currentTime <= segments[0].start) return 0;
    for (let i = 0; i < segments.length; i++) {
      if (currentTime >= segments[i].start && currentTime < displayEnds[i]) return i;
    }
    return segments.length - 1;
  }, [segments, displayEnds, currentTime]);

  const activeSeg = activeIdx >= 0 ? segments[activeIdx] : null;
  const activeDuration = activeIdx >= 0
    ? Math.max(0.3, displayEnds[activeIdx] - segments[activeIdx].start)
    : 0;
  const parsedKb = parseKenBurns(activeSeg?.ken_burns);
  const pair = getTransformPair(parsedKb.motion, parsedKb.intensity);
  const kenLabel = `${parsedKb.motion} · ${parsedKb.intensity}`;
  const activeOffset = activeSeg ? Math.max(0, currentTime - activeSeg.start) : 0;

  const missingFrames = segments.filter((s) => !s.frame_url).length;
  const progressPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  if (!voiceoverUrl || segments.length === 0) {
    return null;
  }

  // Cap stage width so tall formats don't dominate the page. Landscape uses
  // the full 1040; vertical/square presets are narrower so the player height
  // stays comfortable.
  const stageMaxWidth =
    aspectPreset.id === '9:16' ? 360 :
    aspectPreset.id === '1:1'  ? 560 :
    aspectPreset.id === '4:5'  ? 480 :
    1040;

  const stageStyle: React.CSSProperties = fullscreen
    ? {
        // Fullscreen the stage as a BLACK CANVAS and centre the frame
        // inside it with its native aspect ratio preserved. Without this
        // the browser stretches a 9:16 portrait project to 16:9 landscape
        // which crops top + bottom off the frame and feels broken.
        ...styles.stage,
        maxWidth: 'none',
        width: '100vw',
        height: '100vh',
        aspectRatio: 'auto',
        borderRadius: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
      }
    : { ...styles.stage, maxWidth: stageMaxWidth, aspectRatio: aspectPreset.cssRatio };

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={toggleOpen}
        style={styles.headerBtn}
        aria-expanded={open}
      >
        <span style={styles.chev}>{open ? '▾' : '▸'}</span>
        <span style={styles.title}>Preview</span>
        <span style={styles.headerMeta}>
          {segments.length} segment{segments.length === 1 ? '' : 's'}
          {missingFrames > 0 && ` · ${missingFrames} missing frame${missingFrames === 1 ? '' : 's'}`}
          {totalDuration > 0 && ` · ${fmtTs(totalDuration)}`}
        </span>
      </button>
      {open && (
        <div style={styles.body}>
          <div
            ref={stageRef}
            tabIndex={0}
            style={stageStyle}
            onMouseMove={nudgeControls}
            onTouchStart={nudgeControls}
            onClick={(e) => {
              // Clicking the stage toggles play, but not when clicks originate
              // inside the control bar (they stop propagation below).
              if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.playSurface === 'true') {
                togglePlay();
              }
            }}
          >
            <div
              ref={frameRef}
              data-play-surface="true"
              style={
                fullscreen
                  ? {
                      // Centre-fit the project-aspect frame inside the
                      // black fullscreen canvas. max-constrained on both
                      // axes so the browser letterboxes whichever edge
                      // is shortest — portrait stays portrait on a
                      // landscape monitor and vice-versa.
                      position: 'relative',
                      aspectRatio: aspectPreset.cssRatio,
                      maxWidth: '100vw',
                      maxHeight: '100vh',
                      width: 'auto',
                      height: '100%',
                      backgroundColor: '#000',
                      overflow: 'hidden',
                    }
                  : {
                      position: 'absolute',
                      inset: 0,
                      backgroundColor: '#000',
                      overflow: 'hidden',
                    }
              }
            >
              {/* Video segment → real <video> element driven by the
                  preview's play/pause state. Ken Burns zoompan doesn't
                  apply (the source is already motion). Still sits inside
                  the stage so subtitles overlay correctly. */}
              {activeSeg?.is_video && activeSeg?.frame_url && (
                <video
                  key={`${activeSeg.id}-vid`}
                  src={activeSeg.frame_url}
                  data-play-surface="true"
                  autoPlay={playing}
                  muted
                  loop
                  playsInline
                  ref={(v) => {
                    if (!v) return;
                    // Keep playback state synced with the preview's
                    // master play flag so the transport buttons work on
                    // video rows too.
                    if (playing && v.paused) v.play().catch(() => {});
                    if (!playing && !v.paused) v.pause();
                  }}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              )}
              <div
                // Key forces a fresh keyframe run on segment change.
                key={`${activeSeg?.id ?? '_'}-${activeDuration.toFixed(2)}-${kenLabel}`}
                data-play-surface="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  // Video segments render via <video> above; skip the
                  // background-image so the static thumbnail doesn't
                  // peek through the moving frames.
                  backgroundImage:
                    activeSeg?.frame_url && !activeSeg?.is_video
                      ? `url(${activeSeg.frame_url})`
                      : 'none',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  transformOrigin: 'center center',
                  animationName:
                    activeSeg?.frame_url && !activeSeg?.is_video ? 'wm-kb-anim' : 'none',
                  animationDuration: `${activeDuration}s`,
                  animationTimingFunction: 'linear',
                  animationFillMode: 'forwards',
                  animationIterationCount: 1,
                  animationDelay: `-${Math.min(activeOffset, activeDuration)}s`,
                  animationPlayState: playing ? 'running' : 'paused',
                  ['--kb-from' as any]: pair.from,
                  ['--kb-to' as any]: pair.to,
                } as React.CSSProperties}
              />
              {!activeSeg?.frame_url && (
                <span style={styles.stagePlaceholder}>
                  {activeSeg ? `no frame yet for ${activeSeg.id}` : 'no active segment'}
                </span>
              )}
              {activeSeg && subtitles && frameHeightPx > 0 && isSubtitleEnabledFor(activeSeg.id, subtitles) && (() => {
                // Pagination: when on AND segment isn't on a per-word
                // animation (those bypass pagination on the renderer),
                // split the narration into pages and show the active page.
                const resolved = resolveCaptionStyle(subtitles, activeSeg.id);
                const segWords = wordsBySeg[activeSeg.id] ?? null;
                const segDur = Math.max(0.3, displayEnds[activeIdx] - activeSeg.start);
                let displayed = activeSeg.narration ?? '';
                const animPerWord = PER_WORD_ANIMATIONS.has(resolved.animation);
                if (resolved.paginationEnabled && !animPerWord) {
                  const maxLines = subtitles.singleLine ? 1 : resolved.maxLines;
                  const pages: Page[] = paginate(
                    activeSeg.narration ?? '',
                    segWords,
                    activeSeg.start,
                    activeSeg.start + segDur,
                    {
                      maxLines,
                      maxCharsPerLine: resolved.maxCharsPerLine,
                    },
                  );
                  if (pages.length > 0) {
                    const idx = activePageIndex(pages, currentTime);
                    const pick = pages[idx >= 0 ? idx : 0];
                    displayed = pick.lines.join('\n');
                  }
                }
                return (
                  <SubtitleOverlay
                    text={displayed}
                    settings={subtitles}
                    frameHeight={frameHeightPx}
                    frameWidth={frameWidthPx}
                    segId={activeSeg.id}
                    words={segWords ?? undefined}
                    segStart={activeSeg.start}
                    segDuration={segDur}
                  />
                );
              })()}
              <div style={styles.stageBadge}>
                {activeSeg?.id ?? '—'} · {kenLabel}
              </div>
              {/* Center play indicator when paused — YouTube-style affordance. */}
              {!playing && (
                <div style={styles.centerPlay} aria-hidden>
                  ▶
                </div>
              )}
            </div>

            {/* Control bar — stops click-propagation so clicks on controls
                don't bubble up to the play-toggle surface above. */}
            <div
              style={{
                ...styles.controls,
                opacity: controlsVisible ? 1 : 0,
                pointerEvents: controlsVisible ? 'auto' : 'none',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                ref={progressRef}
                style={styles.progressTrack}
                onPointerDown={onProgressPointer}
                onPointerMove={(e) => {
                  if (e.buttons === 1) onProgressPointer(e);
                }}
              >
                <div style={{ ...styles.progressFill, width: `${progressPct}%` }} />
                <div style={{ ...styles.progressHandle, left: `${progressPct}%` }} />
              </div>

              <div style={styles.controlsRow}>
                <button
                  type="button"
                  onClick={togglePlay}
                  style={styles.iconBtn}
                  aria-label={playing ? 'Pause' : 'Play'}
                  title={playing ? 'Pause (Space)' : 'Play (Space)'}
                >
                  {playing ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15L20 12 7 4.5z"/></svg>
                  )}
                </button>

                <div
                  style={styles.volumeWrap}
                  onMouseEnter={() => setShowVolume(true)}
                  onMouseLeave={() => setShowVolume(false)}
                >
                  <button
                    type="button"
                    onClick={toggleMute}
                    style={styles.iconBtn}
                    aria-label={muted ? 'Unmute' : 'Mute'}
                    title={muted ? 'Unmute (M)' : 'Mute (M)'}
                  >
                    {muted || volume === 0 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3L19 9.41 17.59 8 15 10.59 12.41 8 11 9.41 13.59 12 11 14.59 12.41 16 15 13.41 17.59 16 19 14.59 16.59 12z"/></svg>
                    ) : volume < 0.5 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 9v6h4l5 5V4l-5 5H7z"/></svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                    )}
                  </button>
                  {(showVolume || isMobile) && (
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={muted ? 0 : volume}
                      onChange={(e) => setAudioVolume(Number(e.target.value))}
                      style={styles.volumeSlider}
                      aria-label="Volume"
                    />
                  )}
                </div>

                <span style={styles.timecode}>
                  {fmtTs(currentTime)} / {fmtTs(totalDuration)}
                </span>

                <div style={{ flex: 1 }} />

                {activeSeg && (
                  <span style={styles.narration} title={activeSeg.narration}>
                    {activeSeg.narration}
                  </span>
                )}

                <button
                  type="button"
                  onClick={toggleFullscreen}
                  style={styles.iconBtn}
                  aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                >
                  {fullscreen ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/*
            No `crossOrigin` attribute on purpose. Supabase returns
            Access-Control-Allow-Origin: * on the full GET, but partial-
            content Range requests (which the browser fires aggressively
            in CORS mode) don't always carry the same CORS headers
            cleanly — the media pipeline then silently produces no
            audible output while currentTime still advances. Leave the
            fetch in no-cors mode; we don't pipe into Web Audio so we
            don't need the CORS-attributed buffer.
          */}
          <audio
            ref={audioRef}
            src={voiceoverUrl}
            preload="metadata"
            style={{ display: 'none' }}
          />

          {audioError && (
            <div
              style={{
                background: '#450a0a',
                color: '#fca5a5',
                border: '1px solid #7f1d1d',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 12,
                marginTop: 6,
              }}
            >
              ⚠ audio play failed: {audioError}. Check browser tab mute (right-click tab), system volume, or try Cmd+Shift+R to hard-refresh.
            </div>
          )}
          <div style={styles.hint}>
            Preview is CSS-approximate — final render uses ffmpeg zoompan with
            sub-pixel sampling. Good enough to catch pacing and missing frames.
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    marginTop: 14,
    padding: 0,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 10,
    overflow: 'hidden',
  },
  headerBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    background: '#171717',
    border: 'none',
    cursor: 'pointer',
    color: '#f5f5f5',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    textAlign: 'left',
    minHeight: 44,
  },
  chev: { color: '#a3a3a3', fontSize: 12, width: 14 },
  title: {
    fontSize: 13,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#e5e5e5',
  },
  headerMeta: {
    marginLeft: 'auto',
    color: '#a3a3a3',
    fontSize: 12,
    fontWeight: 400,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    alignItems: 'center',
  },
  stage: {
    position: 'relative',
    width: '100%',
    maxWidth: 1040,
    aspectRatio: '16 / 9',
    background: '#000',
    borderRadius: 10,
    overflow: 'hidden',
    boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
    outline: 'none',
    userSelect: 'none',
    cursor: 'pointer',
  },
  stagePlaceholder: {
    position: 'absolute',
    color: '#525252',
    fontSize: 13,
    zIndex: 2,
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
  },
  stageBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    zIndex: 3,
    padding: '3px 8px',
    background: 'rgba(10,10,10,0.72)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 4,
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    fontSize: 11,
    color: '#e5e5e5',
    letterSpacing: 0.3,
    pointerEvents: 'none',
  },
  centerPlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 72,
    height: 72,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontSize: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    zIndex: 3,
    paddingLeft: 6, // optical centering of the ▶
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: '24px 14px 10px',
    background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.45) 60%, transparent 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    transition: 'opacity 200ms ease',
    zIndex: 4,
  },
  progressTrack: {
    position: 'relative',
    height: 14,
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
  },
  progressFill: {
    position: 'absolute',
    left: 0,
    top: 5,
    height: 4,
    background: '#7c3aed',
    borderRadius: 2,
    pointerEvents: 'none',
  },
  progressHandle: {
    position: 'absolute',
    top: '50%',
    width: 12,
    height: 12,
    marginLeft: -6,
    marginTop: -6,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 0 0 2px #7c3aed',
    pointerEvents: 'none',
  },
  controlsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#f5f5f5',
  },
  iconBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#f5f5f5',
    cursor: 'pointer',
    borderRadius: 4,
    padding: 0,
    flexShrink: 0,
  },
  volumeWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  volumeSlider: {
    width: 80,
    accentColor: '#7c3aed',
    cursor: 'pointer',
  },
  timecode: {
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    fontSize: 12,
    color: '#e5e5e5',
    whiteSpace: 'nowrap',
    marginLeft: 4,
  },
  narration: {
    fontSize: 12,
    color: '#d4d4d4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 420,
  },
  hint: {
    fontSize: 11,
    color: '#737373',
    lineHeight: 1.4,
    width: '100%',
    maxWidth: 1040,
  },
};

// Before background-size: cover re-crops, some browsers momentarily show a
// light background flash during frame swap. Guard against that by forcing
// background color on the stage.
