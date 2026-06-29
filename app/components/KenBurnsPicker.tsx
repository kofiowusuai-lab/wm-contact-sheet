'use client';

// Ten-motion × three-intensity Ken Burns picker. Each card previews the
// motion using the CSS keyframe `wm-kb-anim` + CSS custom properties so every
// card shares one keyframe block. Click commits via
// PATCH /api/projects/{id}/timeline. Matches the ffmpeg zoompan filter matrix
// in scripts/render_from_supabase.py — preview is directionally accurate, not
// pixel-identical.

import { useState } from 'react';
import {
  MOTIONS,
  INTENSITIES,
  getTransformPair,
  parseKenBurns,
  serializeKenBurns,
  labelFor,
  type Motion,
  type Intensity,
} from '../lib/kenBurns';

export type { Motion, Intensity } from '../lib/kenBurns';

export default function KenBurnsPicker({
  projectId,
  segId,
  frameUrl,
  current,
  onChange,
  compact = false,
}: {
  projectId: string;
  segId: string;
  frameUrl: string | null;
  current: string | undefined;
  onChange: (next: string) => void;
  /** Narrow-desktop mode: shorter trigger label + smaller padding. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const parsed = parseKenBurns(current);
  const selectedMotion: Motion = parsed.motion;
  const selectedIntensity: Intensity = parsed.intensity;

  const commit = async (motion: Motion, intensity: Intensity) => {
    const next = serializeKenBurns(motion, intensity);
    if (next === serializeKenBurns(selectedMotion, selectedIntensity)) {
      return;
    }
    setSaving(true);
    try {
      onChange(next); // optimistic
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/timeline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seg_id: segId, ken_burns: next }),
      });
      if (!r.ok) {
        onChange(serializeKenBurns(selectedMotion, selectedIntensity)); // rollback
      }
    } finally {
      setSaving(false);
    }
  };

  const triggerLabel = labelFor(selectedMotion);
  const triggerSub = MOTIONS.find((m) => m.value === selectedMotion)?.supportsIntensity
    ? ` · ${selectedIntensity}`
    : '';

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...styles.trigger, ...(compact ? styles.triggerCompact : null) }}
        title={`Ken Burns motion — ${triggerLabel}${triggerSub}`}
      >
        🎬 {compact ? triggerLabel : `${triggerLabel}${triggerSub}`}
        <span style={styles.chev}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.popover}>
            <div style={styles.popHeader}>
              <span>Ken Burns motion · previews</span>
              <IntensityToggle
                value={selectedIntensity}
                disabled={saving || !MOTIONS.find((m) => m.value === selectedMotion)?.supportsIntensity}
                onChange={(next) => commit(selectedMotion, next)}
              />
            </div>
            <div style={styles.gridWrap}>
            <div style={styles.grid}>
              {MOTIONS.map((o) => {
                const intensity = o.supportsIntensity ? selectedIntensity : 'medium';
                const pair = getTransformPair(o.value, intensity);
                const isSelected = o.value === selectedMotion;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => commit(o.value, intensity)}
                    disabled={saving}
                    style={{
                      ...styles.card,
                      ...(isSelected ? styles.cardSelected : null),
                    }}
                    title={o.hint}
                  >
                    <div style={styles.previewFrame}>
                      <div
                        style={{
                          ...styles.previewInner,
                          backgroundImage: frameUrl ? `url(${frameUrl})` : 'none',
                          ['--kb-from' as any]: pair.from,
                          ['--kb-to' as any]: pair.to,
                        } as React.CSSProperties}
                      />
                      {!frameUrl && <span style={styles.previewEmpty}>no frame</span>}
                    </div>
                    <div style={styles.cardLabel}>
                      {o.label}
                      {isSelected && <span style={styles.selectedTag}>current</span>}
                    </div>
                    <div style={styles.cardHint}>{o.hint}</div>
                  </button>
                );
              })}
            </div>
            <div style={styles.footerHint}>
              Never exceeds 130% zoom or 35% pan — keeps AI artifacts off the frame edges.
            </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function IntensityToggle({
  value,
  disabled,
  onChange,
}: {
  value: Intensity;
  disabled: boolean;
  onChange: (next: Intensity) => void;
}) {
  return (
    <div style={{ ...styles.intensityGroup, opacity: disabled ? 0.4 : 1 }}>
      {INTENSITIES.map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => !disabled && onChange(i)}
          disabled={disabled}
          style={{
            ...styles.intensityBtn,
            ...(i === value ? styles.intensityBtnActive : null),
          }}
        >
          {i}
        </button>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-flex' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  triggerCompact: {
    padding: '4px 8px',
    fontSize: 11,
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  chev: { fontSize: 9, color: '#737373', marginLeft: 2 },
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
    width: 620,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '70vh',
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: 0,
    boxShadow: '0 18px 36px rgba(0,0,0,0.55)',
    display: 'flex',
    flexDirection: 'column',
  },
  popHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    padding: '12px 14px',
    background: '#0a0a0a',
    borderBottom: '1px solid #1f1f1f',
  },
  gridWrap: {
    padding: '12px 14px',
  },
  intensityGroup: {
    display: 'inline-flex',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 2,
  },
  intensityBtn: {
    padding: '3px 9px',
    background: 'transparent',
    border: 'none',
    color: '#a3a3a3',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    cursor: 'pointer',
    borderRadius: 4,
  },
  intensityBtnActive: {
    background: '#7c3aed',
    color: '#fff',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: 8,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    padding: 8,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#f5f5f5',
    fontFamily: 'inherit',
  },
  cardSelected: {
    borderColor: '#7c3aed',
    background: '#1e1b4b',
    boxShadow: '0 0 0 1px #7c3aed inset',
  },
  // Two-layer preview: the outer frame is a fixed-size clipping box; the
  // inner element carries the CSS animation. Scaling the inner element up to
  // 1.45× stays clipped to the outer frame regardless of intensity.
  previewFrame: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 5,
    backgroundColor: '#0a0a0a',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewInner: {
    position: 'absolute',
    inset: 0,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    transformOrigin: 'center center',
    animationName: 'wm-kb-anim',
    animationDuration: '2.6s',
    animationIterationCount: 'infinite',
    animationDirection: 'alternate',
    animationTimingFunction: 'ease-in-out',
  },
  previewEmpty: { color: '#525252', fontSize: 11, position: 'relative', zIndex: 1 },
  cardLabel: {
    fontSize: 12,
    fontWeight: 600,
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
  cardHint: {
    fontSize: 10,
    color: '#737373',
    lineHeight: 1.35,
  },
  footerHint: {
    marginTop: 10,
    fontSize: 10,
    color: '#525252',
    lineHeight: 1.4,
    fontStyle: 'italic',
  },
};
