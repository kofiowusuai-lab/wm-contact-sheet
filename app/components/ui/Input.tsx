'use client';

// Form input primitive. Handles the eight or ten places the app asked for
// a styled <input type="text">: search bars, title renames, mass-edit
// prompts, tunnel URL, Jamendo search, etc. Variants stay to a minimum —
// you either want a plain single-line input or the "embedded" variant
// that drops the border for inputs sitting INSIDE another card.

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { colors, motion as motionTokens, radius, space } from './tokens';

type Props = InputHTMLAttributes<HTMLInputElement> & {
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  /** "default" = bordered input on any surface. "embedded" = no border,
   *  meant to sit flush inside a Card header or toolbar slot. */
  inputVariant?: 'default' | 'embedded';
  invalid?: boolean;
};

const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { leadingIcon, trailingIcon, inputVariant = 'default', invalid, style, disabled, ...rest },
  ref,
) {
  const baseBorder =
    inputVariant === 'embedded'
      ? 'transparent'
      : invalid
        ? colors.danger.default
        : colors.border.default;

  return (
    <label
      className="wm-input"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space[4],
        padding: `${space[4]}px ${space[5]}px`,
        background: inputVariant === 'embedded' ? 'transparent' : colors.bg.sunken,
        color: colors.text.primary,
        border: `1px solid ${baseBorder}`,
        borderRadius: radius.md,
        transition: `border-color ${motionTokens.fast}, box-shadow ${motionTokens.fast}`,
        cursor: disabled ? 'not-allowed' : 'text',
        opacity: disabled ? 0.6 : 1,
        width: '100%',
        boxSizing: 'border-box',
        ...(style || {}),
      }}
    >
      {leadingIcon && (
        <span style={{ display: 'inline-flex', color: colors.text.tertiary, width: 16, height: 16 }}>
          {leadingIcon}
        </span>
      )}
      <input
        ref={ref}
        disabled={disabled}
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          color: colors.text.primary,
          fontFamily: 'inherit',
          fontSize: 13,
          padding: 0,
          outline: 'none',
        }}
      />
      {trailingIcon && (
        <span style={{ display: 'inline-flex', color: colors.text.tertiary, width: 16, height: 16 }}>
          {trailingIcon}
        </span>
      )}
    </label>
  );
});

export default Input;
