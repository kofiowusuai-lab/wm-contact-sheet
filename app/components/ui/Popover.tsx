'use client';

// Outside-click-dismissible popover. Replaces the ad-hoc "ref + useEffect
// mousedown" plumbing that was copy-pasted into VoicePicker, RowActionsMenu,
// and the music browse modal. Children render inside a floating panel
// anchored to the `trigger` render-prop element.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { colors, motion as motionTokens, radius, shadow, space, zIndex } from './tokens';

type Props = {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((ctx: { close: () => void }) => ReactNode);
  align?: 'left' | 'right';
  width?: number | string;
  /** When true, closing is only triggered by click outside + Escape, not
   *  by clicking inside. Matches the default "menu stays until dismissed"
   *  behaviour expected by power users. */
  sticky?: boolean;
};

export default function Popover({
  trigger,
  children,
  align = 'left',
  width,
  sticky = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  const toggle = () => setOpen((v) => !v);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      {trigger({ open, toggle })}
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            [align === 'right' ? 'right' : 'left']: 0,
            zIndex: zIndex.popover,
            minWidth: typeof width === 'number' ? width : 220,
            width,
            background: colors.bg.raised,
            border: `1px solid ${colors.border.default}`,
            borderRadius: radius.lg,
            boxShadow: shadow.lg,
            padding: space[2],
            transformOrigin: align === 'right' ? 'top right' : 'top left',
            animation: `wm-pop-in ${motionTokens.base}`,
          }}
          onClick={(e) => {
            if (sticky) e.stopPropagation();
          }}
        >
          {typeof children === 'function' ? children({ close }) : children}
        </div>
      )}
    </div>
  );
}
