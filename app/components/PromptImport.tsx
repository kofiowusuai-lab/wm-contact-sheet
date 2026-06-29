'use client';

import { useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

export default function PromptImport({
  projectId,
  onParsed,
  flash,
}: {
  projectId: string;
  onParsed: () => void;
  flash: (msg: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const isMobile = useIsMobile();

  const parse = async (replace: boolean) => {
    if (!text.trim()) {
      flash('Paste prompts first');
      return;
    }
    if (replace) {
      if (!confirm('Replace every prompt on file with only the ones in this paste? Any existing prompts for IDs not in this text will be removed. This cannot be undone.')) {
        return;
      }
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/parse-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(replace ? { replace: true } : {}) }),
      });
      if (!r.ok) {
        setResult(`Failed: ${(await r.text()).slice(0, 160)}`);
        return;
      }
      const data = (await r.json()) as {
        parsed: number;
        unknown_ids: string[];
        total_prompts: number;
        replaced?: boolean;
        dropped?: number;
      };
      const unknown = data.unknown_ids.length ? ` (${data.unknown_ids.length} unknown IDs: ${data.unknown_ids.slice(0, 5).join(', ')}${data.unknown_ids.length > 5 ? '…' : ''})` : '';
      const droppedNote = data.replaced && data.dropped ? ` · dropped ${data.dropped} orphan${data.dropped === 1 ? '' : 's'}` : '';
      setResult(`Parsed ${data.parsed}${unknown} — ${data.total_prompts} total prompts saved${droppedNote}.`);
      flash(replace ? `Replaced all — ${data.parsed} prompts on file` : `Imported ${data.parsed} prompts`);
      onParsed();
    } finally {
      setBusy(false);
    }
  };
  const run = () => parse(false);
  const replaceAll = () => parse(true);

  return (
    <div style={styles.bar}>
      <div style={styles.header}>Mass import prompts</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`VO_045 — "The bank paid you to build decks."\nWardrobe: Dark hoodie — early career, pre-transformation\n"Anime-style young man in a dark hoodie..."\n\nVO_046 — "..."`}
        style={{ ...styles.textarea, ...(isMobile ? styles.textareaMobile : null) }}
      />
      <div style={styles.row}>
        <button
          onClick={run}
          disabled={busy}
          style={{ ...styles.btnPrimary, ...(isMobile ? styles.btnMobile : null) }}
        >
          {busy ? 'Parsing…' : 'Parse and distribute'}
        </button>
        <button
          onClick={replaceAll}
          disabled={busy}
          style={{ ...styles.btnDanger, ...(isMobile ? styles.btnMobile : null) }}
          title="Wipe every prompt on file and install only what's in this paste. Use this to clear orphans from previous imports."
        >
          {busy ? '…' : '⟲ Replace all prompts'}
        </button>
        <button
          onClick={async () => {
            setBusy(true);
            try {
              const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/snap-timeline`, {
                method: 'POST',
              });
              if (!r.ok) {
                setResult(`Snap failed: ${(await r.text()).slice(0, 140)}`);
                return;
              }
              const d = (await r.json()) as {
                vo_count: number;
                ec_count: number;
                expected_prompt_count: number;
              };
              setResult(
                `Timeline snapped: ${d.vo_count} segments (expected ${d.expected_prompt_count})` +
                (d.ec_count ? ` + ${d.ec_count} end cards` : ''),
              );
              flash(`Timeline now has ${d.vo_count} segments (matches your prompts)`);
              onParsed();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          style={{ ...styles.btnSecondary, ...(isMobile ? styles.btnMobile : null) }}
          title="Rebuild timeline to exactly one row per VO_### narration in your prompts list"
        >
          Snap timeline to prompts
        </button>
        {result && <span style={styles.result}>{result}</span>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  header: { fontSize: 12, color: '#a3a3a3', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 },
  textarea: {
    width: '100%',
    minHeight: 120,
    resize: 'vertical',
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: 10,
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    boxSizing: 'border-box',
  },
  // 16px minimum prevents iOS Safari from auto-zooming on focus.
  textareaMobile: {
    fontSize: 16,
    minHeight: 160,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  btnPrimary: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  btnSecondary: {
    background: '#1e40af',
    color: '#fff',
    border: '1px solid #1d4ed8',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  btnDanger: {
    background: '#7f1d1d',
    color: '#fff',
    border: '1px solid #b91c1c',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  btnMobile: {
    flex: '1 1 100%',
    padding: '12px 14px',
    fontSize: 14,
    minHeight: 46,
  },
  result: { fontSize: 12, color: '#a3a3a3' },
};
