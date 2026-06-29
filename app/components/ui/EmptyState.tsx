'use client';

// Consistent placeholder for the "nothing here yet" case. Shown inside
// Cards when a collection is empty, inside the lightbox when no frame is
// selected, inside the Episode dropdown when a series has zero episodes.
// One component so every empty state reads and feels the same.

import type { ReactNode } from 'react';
import { colors, radius, space } from './tokens';

export default function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space[5],
        padding: `${space[12]}px ${space[8]}px`,
        color: colors.text.secondary,
        textAlign: 'center',
        background: colors.bg.subtle,
        border: `1px dashed ${colors.border.default}`,
        borderRadius: radius.lg,
      }}
    >
      {icon && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.full,
            background: colors.accent.soft,
            color: colors.accent.default,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text.primary }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 12, color: colors.text.tertiary, maxWidth: 420 }}>
          {description}
        </div>
      )}
      {action}
    </div>
  );
}
