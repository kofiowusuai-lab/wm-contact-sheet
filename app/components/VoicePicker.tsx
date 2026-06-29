'use client';

// Voice picker as a collapsed menu: shows the currently-selected voice in a
// single-row trigger; clicking opens a scrollable list of all options. Each
// row has a play button that previews the ElevenLabs sample inline. Only one
// preview plays at a time — clicking another stops the first. Opening the
// menu keeps play buttons accessible for rapid A/B comparison.

import { useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

export type VoiceCardData = {
  voice_id: string;
  name: string;
  preview_url?: string;
  category?: string;
  public_owner_id?: string;
};

export default function VoicePicker({
  voices,
  value,
  onChange,
  generatedIds,
}: {
  voices: VoiceCardData[];
  value: string;
  onChange: (voiceId: string) => void;
  generatedIds?: Set<string>;
}) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    return () => {
      // Stop playback on unmount so a sample doesn't keep going if the
      // panel collapses or the project switches.
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const togglePlay = (voice: VoiceCardData) => {
    if (!voice.preview_url) return;
    // Stop whatever's currently playing
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingId === voice.voice_id) {
      setPlayingId(null);
      return;
    }
    setPreviewError(null);
    const audio = new Audio(voice.preview_url);
    // Full volume, unmuted, explicit — belt-and-braces against browsers
    // that silently apply a previous muted state or autoplay policy.
    // NOTE: deliberately NOT setting `crossOrigin='anonymous'`. ElevenLabs'
    // preview URLs return simple CORS on plain GETs but Range requests in
    // CORS mode can fail silently — audio enters a playing state with no
    // audible output. Leaving the fetch in no-cors is correct because we
    // only need to play, not inspect the buffer via Web Audio.
    audio.volume = 1;
    audio.muted = false;
    audio.onended = () => setPlayingId((p) => (p === voice.voice_id ? null : p));
    audio.onerror = (e) => {
      const err = (audio.error?.message || 'audio element error') + ` (code ${audio.error?.code ?? '?'})`;
      console.error('[VoicePicker] audio error', e, audio.error);
      setPreviewError(err.slice(0, 140));
      setPlayingId((p) => (p === voice.voice_id ? null : p));
    };
    audio.play().catch((err: any) => {
      const msg = String(err?.message || err || 'play() rejected');
      console.error('[VoicePicker] play() rejected', err);
      setPreviewError(msg.slice(0, 140));
      setPlayingId(null);
    });
    audioRef.current = audio;
    setPlayingId(voice.voice_id);
  };

  const selected = voices.find((v) => v.voice_id === value) ?? null;

  if (voices.length === 0) {
    return <div style={styles.empty}>No voices loaded yet.</div>;
  }

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.trigger}
        aria-expanded={open}
      >
        <span style={styles.triggerLabel}>
          {selected ? (
            <>
              <span style={styles.triggerName}>{selected.name}</span>
              <span style={styles.triggerMeta}>
                {selected.category === 'public' ? 'public library' : selected.category || 'voice'}
              </span>
            </>
          ) : (
            <span style={styles.triggerName}>Pick a voice…</span>
          )}
        </span>
        <span style={styles.triggerCount}>
          {voices.length} {voices.length === 1 ? 'option' : 'options'} {open ? '▴' : '▾'}
        </span>
      </button>
      {previewError && (
        <div
          style={{
            background: '#450a0a',
            color: '#fca5a5',
            border: '1px solid #7f1d1d',
            borderRadius: 6,
            padding: '5px 9px',
            fontSize: 11,
            marginTop: 4,
          }}
        >
          ⚠ voice preview failed: {previewError}. Check browser tab mute, system volume, or try a different voice.
        </div>
      )}
      {open && (
        <div style={{ ...styles.menu, ...(isMobile ? styles.menuMobile : null) }} role="radiogroup" aria-label="Voice selection">
          {voices.map((v) => {
            const isSelected = v.voice_id === value;
            const generated = generatedIds?.has(v.voice_id) ?? false;
            const playing = playingId === v.voice_id;
            return (
              <div
                key={v.voice_id}
                role="radio"
                aria-checked={isSelected}
                tabIndex={0}
                onClick={() => {
                  onChange(v.voice_id);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    onChange(v.voice_id);
                    setOpen(false);
                  }
                }}
                style={{
                  ...styles.row,
                  ...(isSelected ? styles.rowSelected : generated ? styles.rowGenerated : null),
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay(v);
                  }}
                  disabled={!v.preview_url}
                  style={{
                    ...styles.playBtn,
                    ...(playing ? styles.playBtnActive : null),
                    opacity: v.preview_url ? 1 : 0.3,
                    cursor: v.preview_url ? 'pointer' : 'not-allowed',
                  }}
                  title={
                    v.preview_url
                      ? playing
                        ? 'Stop preview'
                        : 'Play preview'
                      : 'No preview available'
                  }
                  aria-label={playing ? `Stop preview of ${v.name}` : `Play preview of ${v.name}`}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <div style={styles.rowBody}>
                  <div style={styles.rowName}>
                    {v.name}
                    {isSelected && <span style={styles.selectedTag}>selected</span>}
                    {!isSelected && generated && (
                      <span style={styles.generatedTag} title="Voiceover already generated — clicking swaps instantly, no re-generation cost">
                        generated
                      </span>
                    )}
                  </div>
                  <div style={styles.rowMeta}>
                    {v.category === 'public' ? 'public library' : v.category || 'voice'}
                    {playing && <span style={styles.playingDot} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '10px 12px',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    minHeight: 42,
    textAlign: 'left',
  },
  triggerLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  triggerName: {
    fontWeight: 600,
    color: '#f5f5f5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  triggerMeta: { fontSize: 11, color: '#a3a3a3' },
  triggerCount: {
    fontSize: 11,
    color: '#a3a3a3',
    whiteSpace: 'nowrap',
  },
  menu: {
    display: 'flex',
    flexDirection: 'column',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    maxHeight: 320,
    overflowY: 'auto',
    padding: 4,
  },
  menuMobile: { maxHeight: 260 },
  empty: {
    padding: 20,
    color: '#737373',
    fontSize: 13,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    textAlign: 'center',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'transparent',
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'background 120ms, border-color 120ms',
    outline: 'none',
  },
  rowSelected: {
    background: '#1e1b4b',
    borderColor: '#7c3aed',
  },
  rowGenerated: {
    background: '#0c1e3a',
    borderColor: '#3b82f6',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  rowName: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f5f5f5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  selectedTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#c4b5fd',
    background: 'rgba(124, 58, 237, 0.2)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
  },
  generatedTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#bfdbfe',
    background: 'rgba(59, 130, 246, 0.2)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
  },
  rowMeta: {
    fontSize: 11,
    color: '#737373',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  playBtn: {
    width: 32,
    height: 32,
    minWidth: 32,
    borderRadius: '50%',
    background: '#262626',
    color: '#f5f5f5',
    border: '1px solid #404040',
    fontSize: 11,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: 1,
    flexShrink: 0,
  },
  playBtnActive: {
    background: '#7c3aed',
    borderColor: '#6d28d9',
    color: '#fff',
  },
  playingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#a78bfa',
    display: 'inline-block',
    animation: 'none',
  },
};
