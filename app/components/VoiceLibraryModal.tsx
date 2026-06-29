'use client';

// Browses the cached ElevenLabs shared-voice library (~12k voices) and
// lets the user pull any of them into their personal account. Opens as a
// full-screen overlay so the list has room to breathe without cramming
// another panel into ScriptBar.
//
// Two search modes share one input:
//   • Smart (default): POST /api/voices/library/search — Gemini parses
//     the phrase into structured filters, then the scorer ranks matches.
//     Great for phrases like "warm grandmotherly voice for storytime".
//   • Keyword: GET /api/voices/library?q=… — simple substring match over
//     name + description + labels. Faster, no Gemini round-trip.
//
// Selecting a voice POSTs /api/voices which adds the voice to the user's
// account via ElevenLabs' /voices/add endpoint. We then call the parent's
// onImported callback so ScriptBar can refresh its personal picker and
// activate the new voice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

export type LibraryVoiceRow = {
  voice_id: string;
  name: string;
  description: string;
  category: string;
  gender: string;
  age: string;
  accent: string;
  use_case: string;
  descriptive: string;
  language: string;
  preview_url: string;
  public_owner_id: string;
  featured: boolean;
  cloned_by_count: number;
};

type FilterKey = 'gender' | 'age' | 'accent' | 'use_case' | 'language';

const GENDER_OPTS = ['', 'male', 'female', 'neutral'];
const AGE_OPTS = ['', 'young', 'middle_aged', 'old'];
// Top accents by prevalence in the ElevenLabs library. The full set is
// 30+ strings so we surface the popular ones and let the free-text search
// cover the long tail (e.g. "kansai", "scottish").
const ACCENT_OPTS = [
  '',
  'american',
  'british',
  'australian',
  'canadian',
  'indian',
  'irish',
  'african_american',
  'southern_american',
  'transatlantic',
];
const USE_CASE_OPTS = [
  '',
  'narrative_story',
  'informative_educational',
  'conversational',
  'characters_animation',
  'advertisement',
  'entertainment_tv',
  'social_media',
  'meditation',
];
const LANGUAGE_OPTS = ['', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh', 'pt', 'ru', 'hi', 'ar'];

export default function VoiceLibraryModal({
  open,
  onClose,
  onImported,
  existingVoiceIds,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (voice_id: string, voice_name: string) => void;
  existingVoiceIds: Set<string>;
}) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    gender: '',
    age: '',
    accent: '',
    use_case: '',
    language: '',
  });
  const [voices, setVoices] = useState<LibraryVoiceRow[]>([]);
  const [totalMatching, setTotalMatching] = useState<number>(0);
  const [libraryTotal, setLibraryTotal] = useState<number>(0);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isMobile = useIsMobile();

  const hasActiveFilter = useMemo(
    () => Object.values(filters).some((v) => v) || query.trim().length > 0,
    [filters, query],
  );

  const load = useCallback(
    async (opts: { useSmart?: boolean } = {}) => {
      setLoading(true);
      setErrorMsg(null);
      setFallback(false);
      try {
        if (opts.useSmart && query.trim()) {
          const r = await fetch('/api/voices/library/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.trim(), limit: 60 }),
          });
          if (!r.ok) {
            const t = await r.text();
            setErrorMsg(`search ${r.status}: ${t.slice(0, 160)}`);
            setVoices([]);
            return;
          }
          const j = await r.json();
          setVoices(j.voices || []);
          setTotalMatching(j.total_matching ?? (j.voices?.length ?? 0));
          setLibraryTotal(j.library_total ?? 0);
          setSyncedAt(j.synced_at ?? null);
          setFallback(!!j.fallback);
        } else {
          const params = new URLSearchParams();
          if (query.trim()) params.set('q', query.trim());
          (Object.entries(filters) as [FilterKey, string][]).forEach(([k, v]) => {
            if (v) params.set(k, v);
          });
          params.set('limit', '60');
          const r = await fetch(`/api/voices/library?${params.toString()}`);
          if (!r.ok) {
            const t = await r.text();
            setErrorMsg(`library ${r.status}: ${t.slice(0, 160)}`);
            setVoices([]);
            return;
          }
          const j = await r.json();
          setVoices(j.voices || []);
          setTotalMatching(j.total_matching ?? 0);
          setLibraryTotal(j.library_total ?? 0);
          setSyncedAt(j.synced_at ?? null);
        }
      } finally {
        setLoading(false);
      }
    },
    [query, filters],
  );

  // First open: load the unfiltered default page so the user sees something
  // immediately. Subsequent filter/query changes re-fetch via the effect
  // below; we debounce those to avoid hammering the endpoint on every key.
  useEffect(() => {
    if (open) load();

  }, [open]);

  // Debounced refetch on filter change (no Gemini — filter changes are
  // cheap keyword GETs). Query changes aren't included here; those go
  // through the explicit Search button so Gemini isn't called per key.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(), 200);
    return () => clearTimeout(t);

  }, [filters, open]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const togglePlay = (v: LibraryVoiceRow) => {
    if (!v.preview_url) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingId === v.voice_id) {
      setPlayingId(null);
      return;
    }
    const audio = new Audio(v.preview_url);
    audio.onended = () => setPlayingId((p) => (p === v.voice_id ? null : p));
    audio.onerror = () => setPlayingId((p) => (p === v.voice_id ? null : p));
    audio.play().catch(() => setPlayingId(null));
    audioRef.current = audio;
    setPlayingId(v.voice_id);
  };

  const importVoice = async (v: LibraryVoiceRow) => {
    if (importing) return;
    setImporting(v.voice_id);
    try {
      const r = await fetch('/api/voices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_owner_id: v.public_owner_id,
          voice_id: v.voice_id,
          new_name: v.name.slice(0, 60),
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        setErrorMsg(`import ${r.status}: ${t.slice(0, 160)}`);
        return;
      }
      const j = await r.json();
      const finalId = j?.voice_id || v.voice_id;
      onImported(finalId, v.name);
      audioRef.current?.pause();
      audioRef.current = null;
    } finally {
      setImporting(null);
    }
  };

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setErrorMsg(null);
    try {
      const r = await fetch('/api/voices/library/sync', { method: 'POST' });
      if (!r.ok) {
        const t = await r.text();
        setErrorMsg(`sync ${r.status}: ${t.slice(0, 160)}`);
        return;
      }
      await load();
    } finally {
      setSyncing(false);
    }
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
            <div style={styles.title}>ElevenLabs voice library</div>
            <div style={styles.subtitle}>
              {libraryTotal > 0
                ? `${libraryTotal.toLocaleString()} voices cached${syncedAt ? ` · synced ${timeAgo(syncedAt)}` : ''}`
                : 'Library not synced yet — hit Sync to fetch.'}
            </div>
          </div>
          <div style={styles.headerActions}>
            <button
              onClick={runSync}
              disabled={syncing}
              style={styles.syncBtn}
              title="Re-fetch the full ElevenLabs shared-voice library. Takes ~90 seconds."
            >
              {syncing ? '…syncing' : '⟳ Sync'}
            </button>
            <button onClick={onClose} style={styles.closeBtn} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        <div style={styles.searchRow}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load({ useSmart: true });
              if (e.key === 'Escape') onClose();
            }}
            placeholder='describe the voice (e.g. "warm calm british female narrator for a thriller")'
            style={styles.searchInput}
          />
          <button
            onClick={() => load({ useSmart: true })}
            disabled={loading || !query.trim()}
            style={styles.smartBtn}
            title="Gemini parses your phrase into structured filters then ranks the library"
          >
            ✨ Smart search
          </button>
          <button
            onClick={() => load()}
            disabled={loading}
            style={styles.keywordBtn}
            title="Plain keyword match over name, description, and labels"
          >
            🔍 Keyword
          </button>
        </div>

        <div style={styles.filterRow}>
          <FilterSelect label="Gender" value={filters.gender} opts={GENDER_OPTS}
            onChange={(v) => setFilters((f) => ({ ...f, gender: v }))} />
          <FilterSelect label="Age" value={filters.age} opts={AGE_OPTS}
            onChange={(v) => setFilters((f) => ({ ...f, age: v }))} />
          <FilterSelect label="Accent" value={filters.accent} opts={ACCENT_OPTS}
            onChange={(v) => setFilters((f) => ({ ...f, accent: v }))} />
          <FilterSelect label="Use case" value={filters.use_case} opts={USE_CASE_OPTS}
            onChange={(v) => setFilters((f) => ({ ...f, use_case: v }))} />
          <FilterSelect label="Language" value={filters.language} opts={LANGUAGE_OPTS}
            onChange={(v) => setFilters((f) => ({ ...f, language: v }))} />
          {hasActiveFilter && (
            <button
              onClick={() => {
                setQuery('');
                setFilters({ gender: '', age: '', accent: '', use_case: '', language: '' });
              }}
              style={styles.clearFiltersBtn}
            >
              Clear
            </button>
          )}
        </div>

        <div style={styles.statusBar}>
          <span>
            {loading
              ? 'Searching…'
              : fallback
                ? `No exact matches — showing ${voices.length} popular voices that fit your filters`
                : totalMatching > 0
                  ? `${totalMatching.toLocaleString()} matches · showing top ${voices.length}`
                  : 'No voices match those filters'}
          </span>
          {errorMsg && <span style={styles.errMsg}>{errorMsg}</span>}
        </div>

        <div style={styles.resultsWrap}>
          {voices.map((v) => {
            const owned = existingVoiceIds.has(v.voice_id);
            const isImporting = importing === v.voice_id;
            const playing = playingId === v.voice_id;
            return (
              <div key={v.voice_id} style={styles.resultRow}>
                <button
                  onClick={() => togglePlay(v)}
                  disabled={!v.preview_url}
                  style={{
                    ...styles.playBtn,
                    ...(playing ? styles.playBtnActive : null),
                    opacity: v.preview_url ? 1 : 0.3,
                    cursor: v.preview_url ? 'pointer' : 'not-allowed',
                  }}
                  aria-label={playing ? 'Stop preview' : 'Play preview'}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <div style={styles.resultBody}>
                  <div style={styles.resultName}>
                    {v.name}
                    {v.featured && <span style={styles.featuredTag}>featured</span>}
                    {owned && <span style={styles.ownedTag}>in your account</span>}
                  </div>
                  <div style={styles.resultMeta}>
                    {[v.gender, v.age, v.accent, v.descriptive, v.use_case, v.language]
                      .filter(Boolean)
                      .map((s) => s.replace(/_/g, ' '))
                      .join(' · ')}
                  </div>
                  {v.description && (
                    <div style={styles.resultDesc} title={v.description}>
                      {v.description}
                    </div>
                  )}
                </div>
                {owned ? (
                  <span style={styles.ownedBtn}>Already imported</span>
                ) : (
                  <button
                    onClick={() => importVoice(v)}
                    disabled={isImporting}
                    style={styles.importBtn}
                    title={`Import "${v.name}" into your ElevenLabs account and select it for this episode.`}
                  >
                    {isImporting ? '…importing' : '+ Import'}
                  </button>
                )}
              </div>
            );
          })}
          {!loading && voices.length === 0 && (
            <div style={styles.empty}>Nothing to show — try different filters or a looser phrase.</div>
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
  opts: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label style={styles.filterLabel}>
      <span style={styles.filterLabelText}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={styles.filterSelect}>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o ? o.replace(/_/g, ' ') : 'any'}
          </option>
        ))}
      </select>
    </label>
  );
}

function timeAgo(iso: string): string {
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
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
    width: 'min(980px, 100%)',
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
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  syncBtn: {
    background: '#1e293b',
    color: '#cbd5e1',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  closeBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 14,
    cursor: 'pointer',
  },
  searchRow: {
    display: 'flex',
    gap: 8,
    padding: '12px 16px 6px 16px',
    flexWrap: 'wrap',
  },
  searchInput: {
    flex: '1 1 360px',
    minWidth: 0,
    padding: '10px 12px',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
  },
  smartBtn: {
    background: '#4c1d95',
    color: '#fff',
    border: '1px solid #7c3aed',
    borderRadius: 6,
    padding: '10px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  keywordBtn: {
    background: '#1f2937',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 6,
    padding: '10px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
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
    minWidth: 100,
  },
  clearFiltersBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #262626',
    borderRadius: 5,
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
  statusBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 16px',
    fontSize: 11,
    color: '#737373',
    background: '#0f0f0f',
    borderTop: '1px solid #1f1f1f',
    borderBottom: '1px solid #1f1f1f',
  },
  errMsg: { color: '#fca5a5' },
  resultsWrap: {
    flex: 1,
    overflowY: 'auto',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: '#0f0f0f',
    border: '1px solid #1f1f1f',
    borderRadius: 6,
  },
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
  },
  playBtnActive: { background: '#7c3aed', borderColor: '#6d28d9', color: '#fff' },
  resultBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  resultName: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f5f5f5',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  featuredTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#fde68a',
    background: 'rgba(245,158,11,0.18)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
  },
  ownedTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#bfdbfe',
    background: 'rgba(59,130,246,0.18)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
  },
  resultMeta: { fontSize: 11, color: '#a3a3a3' },
  resultDesc: {
    fontSize: 11,
    color: '#d4d4d4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  importBtn: {
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
  ownedBtn: {
    background: 'transparent',
    color: '#737373',
    fontSize: 11,
    padding: '6px 12px',
    whiteSpace: 'nowrap',
  },
  empty: { padding: 24, textAlign: 'center', color: '#737373', fontSize: 12 },
};
