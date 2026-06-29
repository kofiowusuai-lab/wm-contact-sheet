'use client';

// Per-segment audio preview. Plays the project's voiceover.mp3 windowed
// to [seg.start, seg.end], stopping automatically at the end of the
// segment. Used under the lightbox image so the user can scrub the
// exact audio they're caption-editing against without hunting for a
// separate player.

import { useEffect, useRef, useState } from 'react';
import { colors, space, radius, text } from './ui/tokens';

type Props = {
  voiceoverUrl?: string | null;
  /** Segment start + end in seconds (absolute within the voiceover.mp3). */
  start: number;
  end: number;
  /** Remount cue (pass the segId) so changing segments resets playback. */
  cue: string;
  /** Fires the instant playback begins — parent uses this to restart the
   *  caption-animation CSS timeline so word-level effects stay in sync
   *  with Whisper timestamps. */
  onPlayStart?: () => void;
  /** Fires on pause or natural end. Parent uses it to pause CSS animations. */
  onPlayStop?: () => void;
  /** Fires every audio timeupdate with the absolute time within the
   *  voiceover.mp3 (NOT segment-relative). Used by callers that want to
   *  drive paginated subtitles or other time-locked overlays. */
  onTimeChange?: (absoluteTime: number) => void;
};

export default function SegmentAudioPreview({
  voiceoverUrl,
  start,
  end,
  cue,
  onPlayStart,
  onPlayStop,
  onTimeChange,
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(start);
  const duration = Math.max(0.1, end - start);

  // Reset when the segment or URL changes.
  useEffect(() => {
    setPlaying(false);
    setNow(start);
    const a = audioRef.current;
    if (a) {
      a.pause();
      try { a.currentTime = start; } catch {}
    }
    onPlayStop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue, voiceoverUrl, start]);

  // Auto-pause at seg.end + keep the clock ticking.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      setNow(a.currentTime);
      onTimeChange?.(a.currentTime);
      if (a.currentTime >= end) {
        a.pause();
        try { a.currentTime = start; } catch {}
        setPlaying(false);
        setNow(start);
        onPlayStop?.();
      }
    };
    const onEnded = () => {
      setPlaying(false);
      setNow(start);
      onPlayStop?.();
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnded);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnded);
    };
  }, [start, end, onPlayStop, onTimeChange]);

  const toggle = async () => {
    const a = audioRef.current;
    if (!a || !voiceoverUrl) return;
    if (playing) {
      a.pause();
      setPlaying(false);
      onPlayStop?.();
      return;
    }
    try { a.currentTime = start; } catch {}
    try {
      await a.play();
      setPlaying(true);
      // Notify parent AFTER play() has resolved so the caption CSS
      // animation restart lands on the same tick as actual audio start.
      onPlayStart?.();
    } catch {
      // Autoplay block or transient decode error — stay paused.
      setPlaying(false);
    }
  };

  if (!voiceoverUrl) return null;

  const pct = Math.min(100, Math.max(0, ((now - start) / duration) * 100));

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        style={styles.btn}
        aria-label={playing ? 'Pause audio' : 'Play audio'}
        title={playing ? 'Pause segment audio' : 'Play segment audio'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div style={styles.track}>
        <div style={{ ...styles.trackFill, width: `${pct}%` }} />
      </div>
      <div style={styles.time}>
        {fmt(now - start)} / {fmt(duration)}
      </div>
      <audio ref={audioRef} src={voiceoverUrl} preload="auto" />
    </div>
  );
}

function fmt(s: number) {
  const sec = Math.max(0, s);
  const whole = Math.floor(sec);
  const hundredths = Math.floor((sec - whole) * 100);
  return `${whole}.${hundredths.toString().padStart(2, '0')}s`;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    gap: space[4],
    padding: `${space[3]}px ${space[5]}px`,
    background: 'rgba(23, 23, 23, 0.85)',
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.full,
    color: colors.text.primary,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: colors.accent.default,
    color: colors.accent.contrast,
    border: 'none',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: {
    flex: 1,
    minWidth: 120,
    height: 6,
    borderRadius: radius.full,
    background: colors.bg.sunken,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    background: colors.accent.default,
    transition: 'width 0.08s linear',
  },
  time: {
    ...text.caption,
    color: colors.text.secondary,
    fontFamily: text.mono.fontFamily,
    minWidth: 72,
    textAlign: 'right',
  },
};
