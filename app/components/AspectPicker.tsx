'use client';

// Small segmented-toggle + labeled dropdown for choosing the project's
// output aspect ratio. PATCH /api/projects/{id} persists the pick so both
// preview and render honor it on the next run.

import { useState } from 'react';
import { ASPECT_PRESETS, resolveAspect, type AspectId } from '../lib/aspectRatios';

export default function AspectPicker({
  projectId,
  value,
  hasStampedFrames = false,
  onChange,
  flash,
}: {
  projectId: string;
  value: string | undefined;
  // True when at least one segment already has a `frame_url` + aspect stamp.
  // Triggers the "applies to future generations only" hint on change.
  hasStampedFrames?: boolean;
  onChange: (next: AspectId) => void;
  flash: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = resolveAspect(value);

  const commit = async (next: AspectId) => {
    if (next === current.id) return;
    setBusy(true);
    const prev = current.id;
    onChange(next); // optimistic
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aspect: next }),
        },
      );
      if (!r.ok) {
        onChange(prev as AspectId); // rollback
        flash(`Aspect save failed: ${(await r.text()).slice(0, 120)}`);
        return;
      }
    } catch (e: any) {
      onChange(prev as AspectId);
      flash(`Aspect error: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.wrap} title={`Output aspect — ${current.platforms}`}>
      <span style={styles.label}>Aspect</span>
      <div style={{ ...styles.group, opacity: busy ? 0.6 : 1 }}>
        {ASPECT_PRESETS.map((p) => {
          const selected = p.id === current.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => commit(p.id)}
              disabled={busy}
              style={{
                ...styles.btn,
                ...(selected ? styles.btnActive : null),
              }}
              title={`${p.label} — ${p.platforms} (${p.width}×${p.height})`}
            >
              {p.id}
            </button>
          );
        })}
      </div>
      <span style={styles.hint}>{current.platforms}</span>
      {hasStampedFrames && (
        <span style={styles.forwardNote}>
          Applies to future generations only — already-generated frames keep their stamped aspect.
        </span>
      )}
      {!value && (
        <span style={styles.requiredBadge}>REQUIRED before first generate</span>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    flexWrap: 'wrap',
  },
  label: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: 600,
  },
  group: {
    display: 'inline-flex',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 2,
  },
  btn: {
    padding: '4px 10px',
    background: 'transparent',
    border: 'none',
    color: '#a3a3a3',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    cursor: 'pointer',
    borderRadius: 4,
  },
  btnActive: {
    background: '#7c3aed',
    color: '#fff',
  },
  hint: {
    fontSize: 11,
    color: '#737373',
  },
  forwardNote: {
    fontSize: 10,
    color: '#a3a3a3',
    fontStyle: 'italic',
    flexBasis: '100%',
    lineHeight: 1.35,
    marginTop: 2,
  },
  requiredBadge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.8,
    color: '#fbbf24',
    background: 'rgba(245, 158, 11, 0.12)',
    border: '1px solid #b45309',
    borderRadius: 4,
    padding: '2px 8px',
  },
};
