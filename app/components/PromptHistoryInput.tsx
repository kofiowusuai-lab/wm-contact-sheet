'use client';

// Text input bound to a global prompt history. Shows a dropdown of prior
// prompts that Gemini has ranked against the current text; selecting one
// fills the field. Every successful submission (triggered by the parent via
// `recordUsage`) posts the text back to the history so suggestions stay
// fresh across sessions + projects.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

type HistoryEntry = { text: string; used_at: string; use_count: number };

export type PromptHistoryInputHandle = {
  recordUsage: () => Promise<void>;
};

export default function PromptHistoryInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  handleRef,
  inputStyle,
  inputStyleMobile,
  multiline = false,
  minRows = 3,
  maxRows = 14,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  handleRef?: React.MutableRefObject<PromptHistoryInputHandle | null>;
  inputStyle?: React.CSSProperties;
  inputStyleMobile?: React.CSSProperties;
  /** Render as an auto-growing textarea instead of a single-line input. */
  multiline?: boolean;
  /** Starting rows for the textarea when multiline=true. */
  minRows?: number;
  /** Upper bound before the textarea starts scrolling internally. */
  maxRows?: number;
}) {
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [geminiUsed, setGeminiUsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const lastQueriedRef = useRef('');
  const debounceRef = useRef<number | null>(null);
  const suppressNextSearchRef = useRef(false);
  const isMobile = useIsMobile();

  const fetchSuggestions = useCallback(async (query: string, useGemini: boolean) => {
    try {
      setLoading(true);
      const r = await fetch('/api/global/mass-edit-history/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 8, use_gemini: useGemini }),
      });
      if (!r.ok) return;
      const j = (await r.json()) as { entries: HistoryEntry[]; gemini_used?: boolean };
      setSuggestions(Array.isArray(j.entries) ? j.entries : []);
      setGeminiUsed(Boolean(j.gemini_used));
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced query. Short delay on typing so we don't hammer Gemini on every
  // keystroke — 350ms feels instant but batches quick edits.
  useEffect(() => {
    if (suppressNextSearchRef.current) {
      suppressNextSearchRef.current = false;
      return;
    }
    if (!open) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const q = value.trim();
    if (q === lastQueriedRef.current) return;
    debounceRef.current = window.setTimeout(() => {
      lastQueriedRef.current = q;
      void fetchSuggestions(q, q.length > 0);
    }, q.length === 0 ? 0 : 350);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [value, open, fetchSuggestions]);

  // On focus: show the dropdown and eagerly load the recency-sorted head so
  // users see something useful even before they type.
  const onFocus = useCallback(() => {
    setOpen(true);
    if (lastQueriedRef.current !== value.trim() || suggestions.length === 0) {
      void fetchSuggestions(value.trim(), value.trim().length > 0);
      lastQueriedRef.current = value.trim();
    }
  }, [value, suggestions.length, fetchSuggestions]);

  // Delay closing so clicking an entry still registers before blur wipes the
  // dropdown. onMouseDown → entry click → blur → setOpen(false).
  const closeTimer = useRef<number | null>(null);
  const onBlur = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  }, []);

  const pick = useCallback(
    (text: string) => {
      suppressNextSearchRef.current = true;
      onChange(text);
      setOpen(false);
    },
    [onChange],
  );

  const recordUsage = useCallback(async () => {
    const text = value.trim();
    if (!text) return;
    try {
      await fetch('/api/global/mass-edit-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch {
      /* non-fatal — the edit still ran, history is a convenience */
    }
  }, [value]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { recordUsage };
    return () => {
      if (handleRef.current?.recordUsage === recordUsage) handleRef.current = null;
    };
  }, [handleRef, recordUsage]);

  const mergedInputStyle = {
    ...(inputStyle || {}),
    ...((isMobile && inputStyleMobile) || {}),
  };

  // Auto-grow the textarea to fit its content, bounded by minRows and maxRows.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!multiline) return;
    const el = textareaRef.current;
    if (!el) return;
    // Compute line-height once so we can clamp between minRows and maxRows.
    const style = window.getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 18;
    const paddingY =
      (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const minH = Math.round(lineHeight * minRows + paddingY);
    const maxH = Math.round(lineHeight * maxRows + paddingY);
    el.style.height = 'auto';
    const next = Math.min(maxH, Math.max(minH, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value, multiline, minRows, maxRows, isMobile]);

  return (
    <div style={{ position: 'relative', flex: '1 1 auto', minWidth: 0 }}>
      {multiline ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            // Cmd/Ctrl + Enter fires submit; plain Enter inserts a newline so
            // pasted multi-line prompts keep their structure.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit && !disabled) {
              e.preventDefault();
              onSubmit();
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={minRows}
          style={{
            ...mergedInputStyle,
            // The textarea lives inside a non-flex wrapper div, so `flex: 1`
            // inherited from mergedInputStyle does nothing — force 100% width
            // explicitly so the field fills the available horizontal space.
            width: '100%',
            boxSizing: 'border-box' as const,
            resize: 'vertical' as const,
            minHeight: 64,
            lineHeight: 1.45,
            fontFamily: 'inherit',
            overflow: 'auto',
          }}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit && !disabled) {
              e.preventDefault();
              onSubmit();
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          style={mergedInputStyle}
        />
      )}
      {open && suggestions.length > 0 && (
        <div style={{ ...styles.popover, ...(isMobile ? styles.popoverMobile : null) }}>
          <div style={styles.popHeader}>
            <span style={styles.popTitle}>Prior prompts · {suggestions.length}</span>
            <span style={styles.popSub}>
              {loading ? 'ranking…' : geminiUsed ? 'ranked by Gemini' : 'ranked locally'}
            </span>
          </div>
          <div style={styles.popList}>
            {suggestions.map((s, i) => (
              <button
                key={`${s.text}-${i}`}
                type="button"
                onMouseDown={(e) => {
                  // Prevent blur → otherwise the click would lose focus before pick().
                  e.preventDefault();
                  pick(s.text);
                }}
                style={styles.popItem}
                title={s.text}
              >
                <span style={styles.popItemText}>{s.text}</span>
                <span style={styles.popItemMeta}>× {s.use_count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    right: 0,
    zIndex: 30,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    boxShadow: '0 16px 36px rgba(0,0,0,0.55)',
    maxHeight: 320,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  popoverMobile: {
    maxHeight: 280,
  },
  popHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid #1f1f1f',
    background: '#0f0f0f',
  },
  popTitle: {
    fontSize: 10,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 700,
  },
  popSub: {
    fontSize: 10,
    color: '#737373',
    fontStyle: 'italic',
  },
  popList: {
    overflowY: 'auto',
    padding: 4,
  },
  popItem: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 6,
    color: '#e5e5e5',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
    fontSize: 12,
  },
  popItemText: {
    flex: 1,
    minWidth: 0,
    color: '#e5e5e5',
    lineHeight: 1.4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  popItemMeta: {
    color: '#737373',
    fontSize: 10,
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    flexShrink: 0,
  },
};
