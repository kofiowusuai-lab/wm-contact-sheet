'use client';

// Styled wrapper around the native <select>. We stick with native to keep
// keyboard + screen-reader behaviour free, but layer a consistent chrome
// on top so it doesn't look like a 2002 browser default next to our
// custom Buttons and Inputs.

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { colors, motion as motionTokens, radius, space } from './tokens';

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { invalid, style, disabled, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      disabled={disabled}
      {...rest}
      className="wm-select"
      style={{
        appearance: 'none',
        WebkitAppearance: 'none',
        MozAppearance: 'none',
        padding: `${space[4]}px ${space[8]}px ${space[4]}px ${space[5]}px`,
        background:
          `${colors.bg.sunken} url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='${encodeURIComponent(
            colors.text.tertiary,
          )}' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>") no-repeat right ${space[4]}px center`,
        color: colors.text.primary,
        border: `1px solid ${invalid ? colors.danger.default : colors.border.default}`,
        borderRadius: radius.md,
        fontFamily: 'inherit',
        fontSize: 13,
        minHeight: 36,
        minWidth: 160,
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: 'none',
        transition: `border-color ${motionTokens.fast}`,
        opacity: disabled ? 0.5 : 1,
        ...(style || {}),
      }}
    >
      {children}
    </select>
  );
});

export default Select;
