'use client';

// Raised surface. Wraps the dozen little "panel" divs scattered across the
// app (SeriesBar, Checklist, SubtitleBar, MusicBar, frame rows, Script +
// Voice panel container) into a single consistent shell. Header / footer
// slots are opt-in.

import type { HTMLAttributes, ReactNode } from 'react';
import { colors, radius, space } from './tokens';

type Props = HTMLAttributes<HTMLDivElement> & {
  header?: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'subtle';
  padded?: boolean;
};

export default function Card({
  header,
  footer,
  tone = 'default',
  padded = true,
  children,
  style,
  ...rest
}: Props) {
  const body = padded ? { padding: space[6] } : {};
  return (
    <div
      {...rest}
      style={{
        background: tone === 'subtle' ? colors.bg.subtle : colors.bg.raised,
        border: `1px solid ${colors.border.subtle}`,
        borderRadius: radius.lg,
        overflow: 'hidden',
        ...(style || {}),
      }}
    >
      {header && (
        <div
          style={{
            padding: `${space[5]}px ${space[6]}px`,
            borderBottom: `1px solid ${colors.border.subtle}`,
            background: colors.bg.elevated,
          }}
        >
          {header}
        </div>
      )}
      <div style={body}>{children}</div>
      {footer && (
        <div
          style={{
            padding: `${space[5]}px ${space[6]}px`,
            borderTop: `1px solid ${colors.border.subtle}`,
            background: colors.bg.subtle,
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
