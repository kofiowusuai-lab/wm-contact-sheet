'use client';

// Small toolbar for tuning subtitle overlay. Settings persist to localStorage
// keyed by project ID. Subtitles apply to every frame in the project.

import { useMemo, useState } from 'react';
import type { SubtitleSettings } from './SubtitleOverlay';
import { useIsMobile } from '../lib/useMediaQuery';
import {
  SUBTITLE_FONTS,
  FONT_CATEGORY_LABELS,
  fontFamilyStack,
  type FontCategory,
  type SubtitleFont,
} from '../lib/subtitleFonts';

export default function SubtitleBar({
  value,
  onChange,
}: {
  value: SubtitleSettings;
  onChange: (next: SubtitleSettings) => void;
}) {
  const isMobile = useIsMobile();
  const sep = isMobile ? null : <span style={styles.sep} />;
  const fieldStyle = { ...styles.field, ...(isMobile ? styles.fieldMobile : null) };
  const selectStyle = { ...styles.select, ...(isMobile ? styles.selectMobile : null) };
  const rangeStyle = { ...styles.range, ...(isMobile ? styles.rangeMobile : null) };

  return (
    <div style={{ ...styles.bar, ...(isMobile ? styles.barMobile : null) }}>
      <label style={{ ...styles.toggle, ...(isMobile ? styles.toggleMobile : null) }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span style={styles.label}>Subtitles</span>
      </label>

      {sep}

      <label style={fieldStyle} title="Font size as a fraction of frame height">
        <span style={styles.fieldLabel}>Size</span>
        <input
          type="range"
          min={4}
          max={20}
          step={1}
          value={Math.round(value.fontSizeRatio * 100)}
          onChange={(e) =>
            onChange({ ...value, fontSizeRatio: Number(e.target.value) / 100 })
          }
          disabled={!value.enabled}
          style={rangeStyle}
        />
        <span style={styles.sizeReadout}>
          {Math.round(value.fontSizeRatio * 100)}%
        </span>
      </label>

      {sep}

      <label style={fieldStyle}>
        <span style={styles.fieldLabel}>Vertical</span>
        <select
          value={value.vAlign}
          onChange={(e) =>
            onChange({ ...value, vAlign: e.target.value as SubtitleSettings['vAlign'] })
          }
          disabled={!value.enabled}
          style={selectStyle}
        >
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </select>
      </label>

      <label style={fieldStyle}>
        <span style={styles.fieldLabel}>Horizontal</span>
        <select
          value={value.hAlign}
          onChange={(e) =>
            onChange({ ...value, hAlign: e.target.value as SubtitleSettings['hAlign'] })
          }
          disabled={!value.enabled}
          style={selectStyle}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>

      {sep}

      <label
        style={{ ...styles.toggle, ...(isMobile ? styles.toggleMobile : null) }}
        title="Show the dark box behind text (off = outlined text only)"
      >
        <input
          type="checkbox"
          checked={value.showBackground}
          onChange={(e) => onChange({ ...value, showBackground: e.target.checked })}
          disabled={!value.enabled}
        />
        <span style={styles.fieldLabel}>Background</span>
      </label>

      <label
        style={{ ...styles.toggle, ...(isMobile ? styles.toggleMobile : null) }}
        title="Force text onto a single line"
      >
        <input
          type="checkbox"
          checked={value.singleLine}
          onChange={(e) => onChange({ ...value, singleLine: e.target.checked })}
          disabled={!value.enabled}
        />
        <span style={styles.fieldLabel}>Single line</span>
      </label>

      {sep}

      <FontPicker
        value={value.fontFamily}
        disabled={!value.enabled}
        isMobile={isMobile}
        onChange={(next) => onChange({ ...value, fontFamily: next })}
      />

      {sep}

      <label
        style={{ ...styles.toggle, ...(isMobile ? styles.toggleMobile : null) }}
        title="Auto-page long captions: split narration into chunks of at most Max-lines lines and advance through them within each segment's display window"
      >
        <input
          type="checkbox"
          checked={value.paginationEnabled ?? false}
          onChange={(e) => onChange({ ...value, paginationEnabled: e.target.checked })}
          disabled={!value.enabled}
        />
        <span style={styles.fieldLabel}>Auto-page</span>
      </label>

      <label style={fieldStyle} title="Max lines visible at once when auto-paging">
        <span style={styles.fieldLabel}>Max lines</span>
        <input
          type="number"
          min={1}
          max={4}
          step={1}
          value={value.maxLines ?? 2}
          onChange={(e) => {
            const n = Math.max(1, Math.min(4, Math.round(Number(e.target.value) || 2)));
            onChange({ ...value, maxLines: n });
          }}
          disabled={!value.enabled || !value.paginationEnabled}
          style={{ ...selectStyle, width: 64 }}
        />
      </label>

      <label style={fieldStyle} title="Approx. characters per line for the auto-pager (16-80)">
        <span style={styles.fieldLabel}>Chars/line</span>
        <input
          type="number"
          min={16}
          max={80}
          step={1}
          value={value.maxCharsPerLine ?? 38}
          onChange={(e) => {
            const n = Math.max(16, Math.min(80, Math.round(Number(e.target.value) || 38)));
            onChange({ ...value, maxCharsPerLine: n });
          }}
          disabled={!value.enabled || !value.paginationEnabled}
          style={{ ...selectStyle, width: 72 }}
        />
      </label>
    </div>
  );
}

function FontPicker({
  value,
  disabled,
  isMobile,
  onChange,
}: {
  value: string;
  disabled: boolean;
  isMobile: boolean;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byCat = new Map<FontCategory, SubtitleFont[]>();
    for (const f of SUBTITLE_FONTS) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    return Array.from(byCat.entries());
  }, [filter]);

  const totalVisible = grouped.reduce((n, [, list]) => n + list.length, 0);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          ...styles.fontTrigger,
          ...(isMobile ? styles.fontTriggerMobile : null),
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: fontFamilyStack(value),
        }}
        title={`Subtitle font — ${value}`}
      >
        <span style={styles.fontTriggerLabel}>
          <span style={styles.fontTriggerCaption}>Font</span>
          <span style={styles.fontTriggerName}>{value}</span>
        </span>
        <span style={styles.fontTriggerChev}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <div style={styles.fontBackdrop} onClick={() => setOpen(false)} />
          <div style={{ ...styles.fontPopover, ...(isMobile ? styles.fontPopoverMobile : null) }}>
            <div style={styles.fontPopHeader}>
              <span>Subtitle font · {totalVisible} of {SUBTITLE_FONTS.length}</span>
              <input
                autoFocus
                type="text"
                value={filter}
                placeholder="filter…"
                onChange={(e) => setFilter(e.target.value)}
                style={styles.fontFilter}
              />
            </div>
            <div style={styles.fontList}>
              {grouped.length === 0 && (
                <div style={styles.fontEmpty}>No fonts match "{filter}"</div>
              )}
              {grouped.map(([cat, fonts]) => (
                <div key={cat} style={styles.fontSection}>
                  <div style={styles.fontSectionHeader}>{FONT_CATEGORY_LABELS[cat]}</div>
                  {fonts.map((f) => {
                    const selected = f.name === value;
                    return (
                      <button
                        key={f.name}
                        type="button"
                        onClick={() => {
                          onChange(f.name);
                          setOpen(false);
                        }}
                        style={{
                          ...styles.fontRow,
                          ...(selected ? styles.fontRowSelected : null),
                        }}
                      >
                        <span
                          style={{
                            ...styles.fontRowSample,
                            fontFamily: fontFamilyStack(f.name),
                          }}
                        >
                          {f.name}
                        </span>
                        {selected && <span style={styles.fontRowSelectedTag}>current</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    rowGap: 8,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    fontSize: 12,
    color: '#e5e5e5',
    flexWrap: 'wrap',
  },
  barMobile: {
    gap: 10,
    rowGap: 10,
    padding: '10px',
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    padding: '2px 0',
  },
  toggleMobile: {
    flex: '1 1 45%',
    padding: '6px 2px',
    minHeight: 40,
  },
  label: { fontWeight: 600, letterSpacing: 0.2 },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  fieldMobile: {
    flex: '1 1 100%',
    minHeight: 40,
  },
  fieldLabel: { color: '#a3a3a3', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  range: { width: 110, minWidth: 80 },
  rangeMobile: { flex: 1, width: 'auto', minWidth: 0, height: 28 },
  sizeReadout: {
    color: '#a3a3a3',
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
  },
  select: {
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '5px 8px',
    fontSize: 12,
  },
  selectMobile: {
    flex: 1,
    padding: '8px 10px',
    fontSize: 13,
    minHeight: 40,
  },
  sep: {
    width: 1,
    height: 20,
    background: '#262626',
  },
  fontTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    minHeight: 32,
    whiteSpace: 'nowrap',
  },
  fontTriggerMobile: {
    flex: '1 1 100%',
    minHeight: 42,
    padding: '8px 12px',
    fontSize: 13,
  },
  fontTriggerLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    alignItems: 'flex-start',
  },
  fontTriggerCaption: {
    fontSize: 9,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fontTriggerName: {
    fontSize: 13,
    fontWeight: 600,
    color: '#f5f5f5',
  },
  fontTriggerChev: { color: '#737373', fontSize: 10 },
  fontBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
  },
  fontPopover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: 50,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 10,
    width: 340,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 18px 36px rgba(0,0,0,0.55)',
    overflow: 'hidden',
  },
  fontPopoverMobile: { width: 320 },
  fontPopHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid #1f1f1f',
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  fontFilter: {
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '6px 8px',
    fontSize: 12,
    outline: 'none',
    textTransform: 'none',
    letterSpacing: 0,
    fontWeight: 400,
  },
  fontList: {
    flex: 1,
    overflowY: 'auto',
    padding: '6px 6px',
  },
  fontSection: {
    marginBottom: 6,
  },
  fontSectionHeader: {
    fontSize: 10,
    color: '#737373',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    fontWeight: 700,
    padding: '6px 8px 4px',
  },
  fontRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 6,
    color: '#f5f5f5',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  fontRowSelected: {
    background: '#1e1b4b',
    borderColor: '#7c3aed',
  },
  fontRowSample: {
    fontSize: 15,
    fontWeight: 600,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fontRowSelectedTag: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#c4b5fd',
    background: 'rgba(124, 58, 237, 0.2)',
    padding: '1px 5px',
    borderRadius: 3,
    fontWeight: 700,
    flexShrink: 0,
  },
  fontEmpty: {
    padding: 20,
    color: '#737373',
    fontSize: 12,
    textAlign: 'center',
  },
};
