'use client';

// Left-side "Animations" panel of the 3-column lightbox editor. Hosts the
// caption animation picker (30-strong library grouped by category), the
// animation speed + highlight color, the Ken Burns frame motion picker +
// intensity, and the three commit buttons (apply to this frame / all /
// reset). FrameCaptionEditor next door handles text styling.

import { useState } from 'react';
import { colors, space, radius, text } from './ui/tokens';
import type { SubtitleSettings } from './SubtitleOverlay';
import {
  resolveCaptionStyle,
  setSegmentStyle,
  clearSegmentStyle,
  applyStyleToAllSegments,
} from '../lib/captionStyle';
import {
  CAPTION_ANIMATIONS,
  CATEGORY_LABELS,
  type AnimationCategory,
  type CaptionAnimationId,
} from '../lib/captionAnimations';
import {
  MOTIONS,
  INTENSITIES,
  parseKenBurns,
  serializeKenBurns,
  type Intensity,
  type Motion,
} from '../lib/kenBurns';

type Props = {
  segId: string;
  settings: SubtitleSettings;
  onChange: (next: SubtitleSettings) => void;
  onClose: () => void;
  kenBurns?: string;
  onKenBurnsChange?: (next: string) => void;
};

export default function FrameAnimationPanel({
  segId,
  settings,
  onChange,
  onClose,
  kenBurns,
  onKenBurnsChange,
}: Props) {
  const r = resolveCaptionStyle(settings, segId);
  const [confirmingApplyAll, setConfirmingApplyAll] = useState(false);

  const patch = (p: Partial<{
    highlightColor: string;
    animation: CaptionAnimationId;
    animationSpeed: number;
  }>) => {
    onChange(setSegmentStyle(settings, segId, p));
  };

  const reset = () => onChange(clearSegmentStyle(settings, segId));
  const applyAll = () => {
    onChange(applyStyleToAllSegments(settings, segId));
    setConfirmingApplyAll(false);
  };

  return (
    <div style={styles.scroll}>
      <Row label="Caption animation">
        <AnimationPicker
          current={r.animation}
          onPick={(a) => patch({ animation: a })}
        />
      </Row>

      {r.animation !== 'none' && (
        <Row label={`Speed · ${r.animationSpeed.toFixed(1)}×`}>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={r.animationSpeed}
            onChange={(e) => patch({ animationSpeed: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </Row>
      )}

      {(r.animation === 'word_by_word' ||
        r.animation === 'pop' ||
        r.animation === 'karaoke' ||
        r.animation === 'karaoke_fill' ||
        r.animation === 'wave_color' ||
        r.animation === 'tiktok_highlight' ||
        r.animation === 'gradient_sweep') && (
        <Row label="Highlight color (current word / sweep)">
          <div style={{ display: 'flex', gap: space[3], alignItems: 'center' }}>
            <input
              type="color"
              value={r.highlightColor}
              onChange={(e) => patch({ highlightColor: e.target.value })}
              style={styles.colorSwatch}
            />
            <input
              type="text"
              value={r.highlightColor}
              onChange={(e) => patch({ highlightColor: e.target.value })}
              style={{ ...styles.input, flex: 1 }}
            />
          </div>
        </Row>
      )}

      {onKenBurnsChange && (
        <>
          <div
            style={{
              margin: `${space[6]}px 0 ${space[5]}px`,
              padding: `${space[4]}px 0 0`,
              borderTop: `1px solid ${colors.border.subtle}`,
              ...text.eyebrow,
              color: colors.text.tertiary,
            }}
          >
            Frame motion (Ken Burns)
          </div>
          <KenBurnsInline current={kenBurns} onChange={onKenBurnsChange} />
        </>
      )}

      <div style={{ marginTop: space[6], display: 'flex', flexDirection: 'column', gap: space[3] }}>
        <button
          type="button"
          onClick={onClose}
          style={styles.primaryBtn}
          title="Your edits are already saved to this frame — close the editor"
        >
          Apply to this frame only
        </button>
        <button
          type="button"
          onClick={() => setConfirmingApplyAll(true)}
          style={styles.secondaryBtn}
        >
          Apply to all frames
        </button>
        <button type="button" onClick={reset} style={styles.ghostBtn}>
          Reset to project default
        </button>
      </div>

      {confirmingApplyAll && (
        <div style={styles.confirmBackdrop} onClick={() => setConfirmingApplyAll(false)}>
          <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
            <div style={styles.confirmTitle}>Apply to every frame?</div>
            <div style={styles.confirmBody}>
              This makes the current caption + motion style the project default
              and clears any per-frame overrides you&apos;ve made. Underlying
              frames are untouched.
            </div>
            <div style={styles.confirmActions}>
              <button
                type="button"
                onClick={() => setConfirmingApplyAll(false)}
                style={styles.ghostBtn}
              >
                Cancel
              </button>
              <button type="button" onClick={applyAll} style={styles.dangerBtn}>
                Yes, apply to all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: space[5] }}>
      <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function AnimationPicker({
  current,
  onPick,
}: {
  current: CaptionAnimationId;
  onPick: (a: CaptionAnimationId) => void;
}) {
  const groups = (['entrance', 'emphasis', 'loop', 'reveal', 'kinetic'] as AnimationCategory[])
    .map((cat) => ({
      cat,
      label: CATEGORY_LABELS[cat],
      items: CAPTION_ANIMATIONS.filter((a) => a.category === cat),
    }));
  return (
    <div
      style={{
        maxHeight: 380,
        overflowY: 'auto',
        padding: space[2],
        background: colors.bg.sunken,
        border: `1px solid ${colors.border.default}`,
        borderRadius: radius.md,
      }}
    >
      {groups.map((g) => (
        <div key={g.cat} style={{ marginBottom: space[4] }}>
          <div
            style={{
              ...text.eyebrow,
              color: colors.text.tertiary,
              padding: `${space[2]}px ${space[3]}px`,
            }}
          >
            {g.label}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: space[2],
            }}
          >
            {g.items.map((a) => {
              const on = current === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPick(a.id)}
                  style={{
                    padding: `${space[3]}px ${space[4]}px`,
                    background: on ? colors.accent.soft : colors.bg.raised,
                    color: on ? colors.accent.contrast : colors.text.primary,
                    border: `1px solid ${on ? colors.accent.default : colors.border.default}`,
                    borderRadius: radius.sm,
                    fontSize: text.caption.fontSize,
                    fontWeight: on ? 600 : 500,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  title={a.id}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function KenBurnsInline({
  current,
  onChange,
}: {
  current: string | undefined;
  onChange: (next: string) => void;
}) {
  const parsed = parseKenBurns(current);
  const motionDef = MOTIONS.find((m) => m.value === parsed.motion);
  const supportsIntensity = motionDef?.supportsIntensity ?? false;

  const setMotion = (m: Motion) => {
    const def = MOTIONS.find((x) => x.value === m);
    const nextIntensity: Intensity = def?.supportsIntensity ? parsed.intensity : 'medium';
    onChange(serializeKenBurns(m, nextIntensity));
  };
  const setIntensity = (i: Intensity) => {
    onChange(serializeKenBurns(parsed.motion, i));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
      <div>
        <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>
          Motion
        </div>
        <select
          value={parsed.motion}
          onChange={(e) => setMotion(e.target.value as Motion)}
          style={styles.input}
        >
          {MOTIONS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {motionDef?.hint && (
          <div style={{ ...text.caption, color: colors.text.tertiary, marginTop: space[2] }}>
            {motionDef.hint}
          </div>
        )}
      </div>
      {supportsIntensity && (
        <div>
          <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>
            Intensity — how much zoom / pan before the next frame
          </div>
          <div style={{ display: 'flex', gap: space[2] }}>
            {INTENSITIES.map((i) => {
              const on = parsed.intensity === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIntensity(i)}
                  style={{
                    flex: 1,
                    padding: `${space[3]}px ${space[4]}px`,
                    background: on ? colors.accent.soft : colors.bg.sunken,
                    color: on ? colors.accent.contrast : colors.text.secondary,
                    border: `1px solid ${on ? colors.accent.default : colors.border.default}`,
                    borderRadius: radius.md,
                    fontSize: text.caption.fontSize,
                    fontWeight: on ? 600 : 500,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {i}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: `${space[5]}px ${space[6]}px ${space[8]}px`,
  },
  input: {
    background: colors.bg.sunken,
    color: colors.text.primary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    padding: `${space[3]}px ${space[4]}px`,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },
  colorSwatch: {
    width: 36,
    height: 36,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.sm,
    padding: 0,
    background: 'transparent',
    cursor: 'pointer',
  },
  primaryBtn: {
    background: colors.accent.default,
    color: colors.accent.contrast,
    border: 'none',
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[5]}px`,
    fontSize: text.body.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  secondaryBtn: {
    background: colors.accent.soft,
    color: colors.accent.contrast,
    border: `1px solid ${colors.accent.default}`,
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[5]}px`,
    fontSize: text.body.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  ghostBtn: {
    background: 'transparent',
    color: colors.text.secondary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[5]}px`,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  dangerBtn: {
    background: colors.danger.default,
    color: '#ffffff',
    border: 'none',
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[5]}px`,
    fontSize: text.body.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  confirmBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1200,
  },
  confirmDialog: {
    width: 'min(400px, 90vw)',
    background: colors.bg.raised,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.lg,
    padding: `${space[6]}px ${space[6]}px`,
    boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6)',
  },
  confirmTitle: { ...text.h3, color: colors.text.primary, marginBottom: space[3] },
  confirmBody: { ...text.body, color: colors.text.secondary, marginBottom: space[6] },
  confirmActions: { display: 'flex', gap: space[3], justifyContent: 'flex-end' },
};
