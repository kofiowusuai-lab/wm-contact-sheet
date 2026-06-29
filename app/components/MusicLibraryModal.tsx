'use client';

// Browses Jamendo's royalty-free music catalog and lets the user pick a
// single background track for the active project. Mirrors VoiceLibraryModal's
// UX so the vocabulary (search + mood + genre + inline preview + pick)
// stays consistent.
//
// Jamendo's API is queried on demand — no server-side cache is worth the
// complexity at ~600k tracks. Typing into the input debounces + fires a
// keyword search; selecting mood/genre chips refilters immediately.
//
// On "Use this track" we call back into the parent with the minimal info
// needed to play + credit the track. Per-segment on/off + volume live in
// MusicBar.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';
import { MUSIC_MOOD_PRESETS, MUSIC_GENRE_PRESETS } from '../lib/music';

export type JamendoTrack = {
  track_id: string;
  title: string;
  artist: string;
  audio_url: string;
  duration: number;
  image: string;
  license: string;
  tags: {
    genres: string[];
    vartags: string[];
    instruments: string[];
  };
  releasedate: string;
  album: string;
};

export default function MusicLibraryModal({
  open,
  onClose,
  onPick,
  currentTrackId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (track: JamendoTrack) => void;
  currentTrackId?: string;
}) {
  const [query, setQuery] = useState('');
  const [mood, setMood] = useState('');
  const [genre, setGenre] = useState('');
  const [durationRange, setDurationRange] = useState('');
  const [tracks, setTracks] = useState<JamendoTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isMobile = useIsMobile();

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const p = new URLSearchParams();
      if (query.trim()) p.set('q', query.trim());
      if (mood) p.set('mood', mood);
      if (genre) p.set('genre', genre);
      if (durationRange === 'short') {
        p.set('duration_min', '60');
        p.set('duration_max', '180');
      } else if (durationRange === 'medium') {
        p.set('duration_min', '180');
        p.set('duration_max', '360');
      } else if (durationRange === 'long') {
        p.set('duration_min', '360');
        p.set('duration_max', '900');
      }
      p.set('limit', '30');
      const r = await fetch(`/api/music/search?${p.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setErrorMsg(j?.error || `search ${r.status}`);
        setTracks([]);
        return;
      }
      const j = await r.json();
      setTracks(j.tracks || []);
      setTotal(j.total ?? j.tracks?.length ?? 0);
    } finally {
      setLoading(false);
    }
  }, [query, mood, genre, durationRange]);

  // Debounced refetch on filter/query change.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [open, load]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const togglePlay = (t: JamendoTrack) => {
    if (!t.audio_url) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingId === t.track_id) {
      setPlayingId(null);
      return;
    }
    const audio = new Audio(t.audio_url);
    audio.volume = 0.6;
    audio.onended = () => setPlayingId((p) => (p === t.track_id ? null : p));
    audio.onerror = () => setPlayingId((p) => (p === t.track_id ? null : p));
    audio.play().catch(() => setPlayingId(null));
    audioRef.current = audio;
    setPlayingId(t.track_id);
  };

  const pick = (t: JamendoTrack) => {
    audioRef.current?.pause();
    audioRef.current = null;
    onPick(t);
  };

  if (!open) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        style={{ ...styles.modal, ...(isMobile ? styles.modalMobile : null) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <div>
            <div style={styles.title}>Background music · Jamendo</div>
            <div style={styles.subtitle}>
              Royalty-free tracks, CC licenses. ~600k searchable. Pick one — tick/untick per segment in the row controls.
            </div>
          </div>
          <button onClick={onClose} style={styles.closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={styles.searchRow}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
            placeholder='search tracks (e.g. "slow piano", "tense drone", "uplifting strings")'
            style={styles.searchInput}
          />
        </div>

        <div style={styles.filterRow}>
          <FilterSelect
            label="Mood"
            value={mood}
            opts={MUSIC_MOOD_PRESETS}
            onChange={setMood}
          />
          <FilterSelect
            label="Genre"
            value={genre}
            opts={MUSIC_GENRE_PRESETS}
            onChange={setGenre}
          />
          <FilterSelect
            label="Length"
            value={durationRange}
            opts={[
              { id: '', label: 'any' },
              { id: 'short', label: '1–3 min' },
              { id: 'medium', label: '3–6 min' },
              { id: 'long', label: '6–15 min' },
            ]}
            onChange={setDurationRange}
          />
          {(query || mood || genre || durationRange) && (
            <button
              onClick={() => {
                setQuery('');
                setMood('');
                setGenre('');
                setDurationRange('');
              }}
              style={styles.clearBtn}
            >
              Clear
            </button>
          )}
        </div>

        <div style={styles.statusBar}>
          <span>
            {loading
              ? 'Searching Jamendo…'
              : errorMsg
                ? `⚠ ${errorMsg}`
                : `${total.toLocaleString()} tracks match · showing ${tracks.length}`}
          </span>
        </div>

        <div style={styles.resultsWrap}>
          {tracks.map((t) => {
            const playing = playingId === t.track_id;
            const selected = currentTrackId === t.track_id;
            return (
              <div
                key={t.track_id}
                style={{
                  ...styles.row,
                  ...(selected ? styles.rowSelected : null),
                }}
              >
                <button
                  onClick={() => togglePlay(t)}
                  disabled={!t.audio_url}
                  style={{
                    ...styles.playBtn,
                    ...(playing ? styles.playBtnActive : null),
                  }}
                  aria-label={playing ? 'Stop' : 'Play preview'}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <div style={styles.rowBody}>
                  <div style={styles.rowTitle}>
                    {t.title || '(untitled)'}
                    {selected && <span style={styles.currentTag}>current</span>}
                  </div>
                  <div style={styles.rowMeta}>
                    by {t.artist || 'unknown'} · {formatDuration(t.duration)}
                    {t.tags.genres.length > 0 && ` · ${t.tags.genres.slice(0, 3).join(', ')}`}
                    {t.tags.vartags.length > 0 && ` · ${t.tags.vartags.slice(0, 3).join(', ')}`}
                  </div>
                </div>
                {selected ? (
                  <span style={styles.useBtnDisabled}>Using</span>
                ) : (
                  <button onClick={() => pick(t)} style={styles.useBtn}>
                    Use this track
                  </button>
                )}
              </div>
            );
          })}
          {!loading && tracks.length === 0 && !errorMsg && (
            <div style={styles.empty}>Nothing found — try different filters or a looser phrase.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  opts,
  onChange,
}: {
  label: string;
  value: string;
  opts: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label style={styles.filterLabel}>
      <span style={styles.filterLabelText}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={styles.filterSelect}>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatDuration(sec: number): string {
  if (!sec || !isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.72)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '4vh 16px',
    overflowY: 'auto',
  },
  modal: {
    width: 'min(960px, 100%)',
    maxHeight: '92vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 12,
    boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
    overflow: 'hidden',
  },
  modalMobile: { width: '100%', maxHeight: '95vh' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    padding: '14px 16px',
    borderBottom: '1px solid #1f1f1f',
    background: '#0f0f0f',
  },
  title: { fontSize: 16, fontWeight: 700, color: '#f5f5f5' },
  subtitle: { fontSize: 11, color: '#a3a3a3', marginTop: 2 },
  closeBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 14,
    cursor: 'pointer',
  },
  searchRow: { padding: '12px 16px 6px 16px' },
  searchInput: {
    width: '100%',
    padding: '10px 12px',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  filterRow: {
    display: 'flex',
    gap: 10,
    padding: '4px 16px 10px 16px',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  filterLabel: { display: 'flex', flexDirection: 'column', gap: 3 },
  filterLabelText: { fontSize: 10, color: '#737373', textTransform: 'uppercase', letterSpacing: 0.5 },
  filterSelect: {
    padding: '6px 8px',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 5,
    fontSize: 12,
    fontFamily: 'inherit',
    minWidth: 120,
  },
  clearBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #262626',
    borderRadius: 5,
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
  statusBar: {
    padding: '6px 16px',
    fontSize: 11,
    color: '#737373',
    background: '#0f0f0f',
    borderTop: '1px solid #1f1f1f',
    borderBottom: '1px solid #1f1f1f',
  },
  resultsWrap: {
    flex: 1,
    overflowY: 'auto',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: '#0f0f0f',
    border: '1px solid #1f1f1f',
    borderRadius: 6,
  },
  rowSelected: { background: '#1e1b4b', borderColor: '#7c3aed' },
  playBtn: {
    width: 36,
    height: 36,
    minWidth: 36,
    borderRadius: '50%',
    background: '#262626',
    color: '#f5f5f5',
    border: '1px solid #404040',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: 1,
    flexShrink: 0,
    cursor: 'pointer',
  },
  playBtnActive: { background: '#7c3aed', borderColor: '#6d28d9', color: '#fff' },
  rowBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f5f5f5',
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  currentTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#c4b5fd',
    background: 'rgba(124,58,237,0.2)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
  },
  rowMeta: { fontSize: 11, color: '#a3a3a3' },
  useBtn: {
    background: '#065f46',
    color: '#d1fae5',
    border: '1px solid #10b981',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  useBtnDisabled: {
    background: 'transparent',
    color: '#737373',
    fontSize: 11,
    padding: '6px 12px',
    whiteSpace: 'nowrap',
  },
  empty: { padding: 24, textAlign: 'center', color: '#737373', fontSize: 12 },
};
