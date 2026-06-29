'use client';

// Word-level segment splitter. Opens a popover showing every Whisper word
// spoken in this segment. Click a word → that word's start timestamp becomes
// the split boundary and a new empty segment is inserted right after.
//
// Why Whisper words (not the narration string)? The script narration may not
// tokenize 1:1 with Whisper's word list (contractions, punctuation). Using
// the server's source of truth keeps the split deterministic.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment } from '../lib/blob';

type Word = { word: string; start: number; end: number };

export default function SplitPicker({
  projectId,
  segId,
  segStart,
  segEnd,
  narration,
  onSplit,
  onTimelineReplace,
  flash,
}: {
  projectId: string;
  segId: string;
  segStart: number;
  segEnd: number;
  narration: string;
  onSplit: () => void | Promise<void>;
  onTimelineReplace?: (next: Segment[]) => void;
  flash: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<Word[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const loadWords = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setError(null);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/words`,
        { cache: 'no-store' },
      );
      if (!r.ok) {
        setError(`Failed to load Whisper words: ${r.status}`);
        setWords([]);
        return;
      }
      const data = (await r.json()) as { words: Word[] };
      const all = Array.isArray(data.words) ? data.words : [];
      if (all.length === 0) {
        setError('No Whisper words.json for this episode — rerun Generate voiceover + timeline so the aligner produces word-level timings.');
        setWords([]);
        return;
      }
      // Filter words that fall within this segment's audio range.
      const mine = all.filter((w) => w.start >= segStart && w.start < segEnd);
      setWords(mine);
      if (mine.length === 0) {
        setError(`Whisper has ${all.length} words on file but none land inside [${segStart.toFixed(2)}s, ${segEnd.toFixed(2)}s] — this segment may be silent or misaligned.`);
      }
    } catch (e: any) {
      setError(`Load error: ${String(e?.message || e).slice(0, 120)}`);
      setWords([]);
    }
  }, [projectId, segStart, segEnd]);

  useEffect(() => {
    if (open) loadWords();
  }, [open, loadWords]);

  const commit = async (splitAtTime: number) => {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/timeline/split`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seg_id: segId, split_at_time: splitAtTime }),
        },
      );
      if (!r.ok) {
        const err = (await r.text()).slice(0, 200);
        flash(`Split failed: ${err}`);
        setError(err);
        return;
      }
      const data = await r.json();
      setOpen(false);
      // Prefer server-returned timeline so we sidestep Supabase's read-after
      // -write propagation delay; fall back to a full reload otherwise.
      if (Array.isArray(data.timeline) && onTimelineReplace) {
        onTimelineReplace(data.timeline);
      } else {
        await onSplit();
      }
      flash(`Split into ${data.first?.id ?? '?'} + ${data.second?.id ?? '?'}`);
    } catch (e: any) {
      flash(`Split error: ${String(e?.message || e).slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const narrationWordCount = narration.trim().split(/\s+/).filter(Boolean).length;
  if (narrationWordCount < 2) return null;

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.trigger}
        title="Split this segment at a word"
      >
        ✂ Split
      </button>
      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.popover}>
            <div style={styles.popHeader}>
              Click the word that should START the new segment
            </div>
            {error && <div style={styles.error}>{error}</div>}
            {!words && !error && <div style={styles.loading}>Loading words…</div>}
            {words && words.length > 0 && (
              <div style={styles.wordCloud}>
                {words.map((w, i) => {
                  // index 0 is the first word of the segment — splitting before
                  // it would just recreate the same segment. Disable it.
                  const disabled = i === 0 || busy;
                  return (
                    <button
                      key={`${i}-${w.word}`}
                      type="button"
                      onClick={() => !disabled && commit(w.start)}
                      disabled={disabled}
                      style={{
                        ...styles.word,
                        ...(disabled ? styles.wordDisabled : null),
                      }}
                      title={
                        i === 0
                          ? 'Splitting before the first word is a no-op'
                          : `New segment starts at ${w.start.toFixed(2)}s with "${w.word}"`
                      }
                    >
                      {w.word}
                    </button>
                  );
                })}
              </div>
            )}
            <div style={styles.hint}>
              Audio isn't modified — only the timeline is re-carved at the word's
              Whisper timestamp. The new row has no frame yet — generate one.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-flex' },
  trigger: {
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
  },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: 50,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 10,
    padding: 10,
    width: 380,
    maxWidth: 'calc(100vw - 24px)',
    boxShadow: '0 18px 36px rgba(0,0,0,0.55)',
  },
  popHeader: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    marginBottom: 8,
  },
  loading: { fontSize: 12, color: '#a3a3a3', padding: 12, textAlign: 'center' },
  error: {
    fontSize: 11,
    color: '#fca5a5',
    background: '#1f0d0d',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
    lineHeight: 1.4,
  },
  wordCloud: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: 6,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    maxHeight: 240,
    overflowY: 'auto',
  },
  word: {
    background: '#0a0a0a',
    color: '#e5e5e5',
    border: '1px solid #262626',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: 'pointer',
    lineHeight: 1.3,
  },
  wordDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },
  hint: {
    marginTop: 8,
    fontSize: 10,
    color: '#737373',
    lineHeight: 1.4,
  },
};
