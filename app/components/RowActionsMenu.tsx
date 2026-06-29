'use client';

// "More actions" popover for a single frame row. The original Row rendered
// ten-plus buttons in one horizontal strip (Render, Generate, Clear, Ken
// Burns picker, Location picker, Undo, Redo, Split, Merge, CC toggle,
// music toggle, …). On mobile it wrapped into four-row button soup; on
// desktop it was still intimidating for anyone opening the tool for the
// first time.
//
// This component owns the SECONDARY controls — Ken Burns, Location, Undo,
// Redo, Split, Merge — behind a single ⋮ button. Primary actions (Render,
// Generate, Clear, plus the CC and music toggles) stay inline in Row so
// the common path stays one click.
//
// Close-on-outside-click is done with a single document-level mousedown
// listener because a focusout-based solution loses the click on the
// inner-select dropdowns (KenBurnsPicker / LocationPicker emit their own
// menus and stealing focus from those would close this menu too).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreVertical } from 'lucide-react';
import { useIsMobile } from '../lib/useMediaQuery';
import { colors, radius, shadow, space, zIndex } from './ui';

export type RowActionItem =
  | {
      kind: 'button';
      label: string;
      onClick: () => void;
      disabled?: boolean;
      title?: string;
      variant?: 'default' | 'danger';
    }
  | {
      kind: 'custom';
      label: string;
      node: ReactNode;
      hint?: string;
    }
  | { kind: 'divider' };

export default function RowActionsMenu({
  items,
}: {
  items: RowActionItem[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={wrapRef} style={styles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="wm-btn"
        data-variant="secondary"
        style={{
          ...styles.trigger,
          ...(isMobile ? styles.triggerMobile : null),
          background: open ? colors.bg.elevated : colors.bg.raised,
          borderColor: open ? colors.border.strong : colors.border.default,
          color: colors.text.secondary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title="More actions for this frame (Ken Burns, location, split, merge, undo, redo)"
        aria-label="More frame actions"
        aria-expanded={open}
      >
        <MoreVertical size={16} strokeWidth={2} />
      </button>
      {open && (
        <div style={{ ...styles.menu, ...(isMobile ? styles.menuMobile : null) }}>
          {items.map((item, i) => {
            if (item.kind === 'divider') {
              return <div key={`div-${i}`} style={styles.divider} />;
            }
            if (item.kind === 'button') {
              return (
                <button
                  key={`${item.label}-${i}`}
                  type="button"
                  onClick={() => {
                    if (item.disabled) return;
                    item.onClick();
                    setOpen(false);
                  }}
                  disabled={item.disabled}
                  style={{
                    ...styles.item,
                    ...(item.variant === 'danger' ? styles.itemDanger : null),
                    opacity: item.disabled ? 0.4 : 1,
                    cursor: item.disabled ? 'not-allowed' : 'pointer',
                  }}
                  title={item.title}
                >
                  {item.label}
                </button>
              );
            }
            // custom — renders an existing component (KenBurnsPicker, etc.)
            // inline in the menu. Close-on-click stays the caller's job.
            return (
              <div key={`${item.label}-${i}`} style={styles.customWrap}>
                <div style={styles.customLabel}>{item.label}</div>
                <div style={styles.customNode}>{item.node}</div>
                {item.hint && <div style={styles.customHint}>{item.hint}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    display: 'inline-block',
  },
  trigger: {
    minWidth: 28,
    height: 28,
    padding: '0 6px',
    borderRadius: radius.md,
    border: `1px solid ${colors.border.default}`,
    background: colors.bg.raised,
    color: colors.text.secondary,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  triggerMobile: {
    minHeight: 36,
    minWidth: 36,
    fontSize: 18,
  },
  menu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: zIndex.popover,
    minWidth: 220,
    background: colors.bg.raised,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.lg,
    boxShadow: shadow.lg,
    padding: space[2],
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  menuMobile: {
    left: 0,
    right: 'auto',
    minWidth: 260,
  },
  item: {
    textAlign: 'left',
    padding: `${space[4]}px ${space[5]}px`,
    background: 'transparent',
    border: 'none',
    color: colors.text.primary,
    borderRadius: radius.sm,
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  itemDanger: {
    color: colors.danger.text,
  },
  divider: {
    height: 1,
    background: colors.border.subtle,
    margin: `${space[2]}px ${space[1]}px`,
  },
  customWrap: {
    padding: `${space[3]}px ${space[5]}px`,
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  customLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    color: colors.text.tertiary,
    letterSpacing: '0.08em',
    fontWeight: 700,
  },
  customNode: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
  },
  customHint: {
    fontSize: 10,
    color: colors.text.disabled,
    fontStyle: 'italic',
  },
};
