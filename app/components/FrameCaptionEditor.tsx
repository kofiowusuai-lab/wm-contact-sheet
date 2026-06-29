'use client';

// Right-side "Captions" panel of the 3-column lightbox editor. Covers
// text styling only — font, size, color, bold/italic/underline, anchor,
// and positional offsets. Every field writes through to
// `subtitles.segmentStyles[segId]` on change so the live overlay updates
// instantly. Animation + frame-motion + apply-all buttons live in the
// sibling FrameAnimationPanel on the left.

import { colors, space, radius, text } from './ui/tokens';
import type { SubtitleSettings } from './SubtitleOverlay';
import {
  resolveCaptionStyle,
  setSegmentStyle,
} from '../lib/captionStyle';
import { SUBTITLE_FONTS } from '../lib/subtitleFonts';

type Props = {
  segId: string;
  settings: SubtitleSettings;
  onChange: (next: SubtitleSettings) => void;
};

export default function FrameCaptionEditor({ segId, settings, onChange }: Props) {
  const r = resolveCaptionStyle(settings, segId);

  const patch = (p: Partial<{
    fontFamily: string;
    color: string;
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    vAlign: 'top' | 'middle' | 'bottom';
    hAlign: 'left' | 'center' | 'right';
    offsetXPct: number;
    offsetYPct: number;
    paginationEnabled: boolean;
    maxLines: number;
    maxCharsPerLine: number;
  }>) => {
    onChange(setSegmentStyle(settings, segId, p));
  };

  const tog = (v: boolean) => ({
    ...styles.toggleBtn,
    ...(v ? styles.toggleBtnOn : null),
  });

  return (
    <div style={styles.scroll}>
      <Row label="Font">
        <select
          value={r.fontFamily}
          onChange={(e) => patch({ fontFamily: e.target.value })}
          style={styles.input}
        >
          {SUBTITLE_FONTS.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
      </Row>

      <Row label={`Size · ${(r.sizeRatio * 100).toFixed(0)}% of frame`}>
        <input
          type="range"
          min={0.03}
          max={0.2}
          step={0.005}
          value={r.sizeRatio}
          onChange={(e) => patch({ size: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </Row>

      <Row label="Color">
        <div style={{ display: 'flex', gap: space[3], alignItems: 'center' }}>
          <input
            type="color"
            value={r.color}
            onChange={(e) => patch({ color: e.target.value })}
            style={styles.colorSwatch}
          />
          <input
            type="text"
            value={r.color}
            onChange={(e) => patch({ color: e.target.value })}
            style={{ ...styles.input, flex: 1 }}
          />
        </div>
      </Row>

      <Row label="Style">
        <div style={{ display: 'flex', gap: space[3] }}>
          <button type="button" onClick={() => patch({ bold: !r.bold })} style={tog(r.bold)}>
            <strong>B</strong>
          </button>
          <button type="button" onClick={() => patch({ italic: !r.italic })} style={tog(r.italic)}>
            <em>I</em>
          </button>
          <button type="button" onClick={() => patch({ underline: !r.underline })} style={tog(r.underline)}>
            <span style={{ textDecoration: 'underline' }}>U</span>
          </button>
        </div>
      </Row>

      <Row label="Anchor">
        <div style={styles.anchorGrid}>
          {(['top', 'middle', 'bottom'] as const).map((v) =>
            (['left', 'center', 'right'] as const).map((h) => {
              const on = r.vAlign === v && r.hAlign === h;
              return (
                <button
                  key={`${v}-${h}`}
                  type="button"
                  onClick={() => patch({ vAlign: v, hAlign: h })}
                  style={{
                    ...styles.anchorCell,
                    ...(on ? styles.anchorCellOn : null),
                  }}
                  title={`${v}-${h}`}
                >
                  {on ? '●' : '○'}
                </button>
              );
            }),
          )}
        </div>
      </Row>

      <Row label={`Offset X · ${r.offsetXPct.toFixed(0)}%`}>
        <input
          type="range"
          min={-40}
          max={40}
          step={1}
          value={r.offsetXPct}
          onChange={(e) => patch({ offsetXPct: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </Row>

      <Row label={`Offset Y · ${r.offsetYPct.toFixed(0)}%`}>
        <input
          type="range"
          min={-40}
          max={40}
          step={1}
          value={r.offsetYPct}
          onChange={(e) => patch({ offsetYPct: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </Row>

      <Row label="Auto-page long captions">
        <button
          type="button"
          onClick={() => patch({ paginationEnabled: !r.paginationEnabled })}
          style={tog(r.paginationEnabled)}
        >
          {r.paginationEnabled ? 'On' : 'Off'}
        </button>
      </Row>

      <Row label={`Max lines · ${r.maxLines}`}>
        <input
          type="range"
          min={1}
          max={4}
          step={1}
          value={r.maxLines}
          onChange={(e) => patch({ maxLines: Number(e.target.value) })}
          disabled={!r.paginationEnabled}
          style={{ width: '100%' }}
        />
      </Row>

      <Row label={`Chars per line · ${r.maxCharsPerLine}`}>
        <input
          type="range"
          min={16}
          max={80}
          step={1}
          value={r.maxCharsPerLine}
          onChange={(e) => patch({ maxCharsPerLine: Number(e.target.value) })}
          disabled={!r.paginationEnabled}
          style={{ width: '100%' }}
        />
      </Row>
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
  toggleBtn: {
    width: 44,
    height: 36,
    background: colors.bg.sunken,
    color: colors.text.secondary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  toggleBtnOn: {
    background: colors.accent.soft,
    color: colors.accent.contrast,
    border: `1px solid ${colors.accent.default}`,
  },
  anchorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: space[2],
    maxWidth: 140,
  },
  anchorCell: {
    width: 42,
    height: 36,
    background: colors.bg.sunken,
    color: colors.text.tertiary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.sm,
    fontFamily: 'inherit',
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  anchorCellOn: {
    background: colors.accent.soft,
    color: colors.accent.contrast,
    border: `1px solid ${colors.accent.default}`,
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
};
