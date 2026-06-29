'use client';

// Primary UI button. Four tiers define the entire action vocabulary so a
// user can scan any screen and instinctively know "indigo = commit, grey =
// alternative, ghost = utility, red = destructive."
//
//   primary   — the single most important action on screen. Indigo fill.
//   secondary — alternative actions, common navigational choices.
//   ghost     — utility / tertiary. Transparent, borders only on hover.
//   danger    — destructive. Red. Confirm dialogs wrap it where possible.
//
// Sizes stay to three (sm / md / lg) so there's no "just slightly bigger"
// one-off. Icon slots live on both sides; pass a Lucide icon as a
// ReactNode and we handle sizing + alignment.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { colors, radius, motion as motionTokens, space, shadow } from './tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  /** When true the button renders the loading dot + dims. Prefer this
   *  over swapping the label text manually. */
  loading?: boolean;
};

export default function Button({
  variant = 'secondary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  fullWidth,
  loading,
  disabled,
  children,
  style,
  ...rest
}: Props) {
  const sz = sizeStyles[size];
  const iconSize = sz.iconSize;
  const vStyle = variantStyles[variant];
  const isDisabled = disabled || loading;

  return (
    <button
      {...rest}
      disabled={isDisabled}
      data-variant={variant}
      className={`wm-btn ${rest.className ?? ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space[4],
        fontFamily: 'inherit',
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        borderRadius: radius.md,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        transition: `background ${motionTokens.fast}, border-color ${motionTokens.fast}, color ${motionTokens.fast}, box-shadow ${motionTokens.fast}`,
        opacity: isDisabled ? 0.5 : 1,
        width: fullWidth ? '100%' : undefined,
        fontSize: sz.fontSize,
        padding: sz.padding,
        minHeight: sz.minHeight,
        ...vStyle,
        ...(style || {}),
      }}
    >
      {loading && (
        <span
          aria-hidden
          style={{
            width: iconSize,
            height: iconSize,
            borderRadius: '50%',
            border: `2px solid currentColor`,
            borderTopColor: 'transparent',
            animation: 'wm-spin 0.7s linear infinite',
          }}
        />
      )}
      {!loading && leadingIcon && (
        <span style={{ display: 'inline-flex', width: iconSize, height: iconSize }}>
          {leadingIcon}
        </span>
      )}
      {children && <span>{children}</span>}
      {!loading && trailingIcon && (
        <span style={{ display: 'inline-flex', width: iconSize, height: iconSize }}>
          {trailingIcon}
        </span>
      )}
    </button>
  );
}

const sizeStyles: Record<ButtonSize, { padding: string; minHeight: number; fontSize: number; iconSize: number }> = {
  sm: { padding: '6px 10px', minHeight: 28, fontSize: 12, iconSize: 14 },
  md: { padding: '8px 14px', minHeight: 36, fontSize: 13, iconSize: 16 },
  lg: { padding: '10px 18px', minHeight: 44, fontSize: 14, iconSize: 18 },
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: colors.accent.default,
    color: colors.accent.contrast,
    border: `1px solid ${colors.accent.default}`,
    boxShadow: shadow.sm,
  },
  secondary: {
    background: colors.bg.elevated,
    color: colors.text.primary,
    border: `1px solid ${colors.border.default}`,
  },
  ghost: {
    background: 'transparent',
    color: colors.text.secondary,
    border: '1px solid transparent',
  },
  danger: {
    background: colors.bg.elevated,
    color: colors.danger.text,
    border: `1px solid ${colors.danger.default}`,
  },
};
