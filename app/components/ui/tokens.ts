// Design tokens for the wm-contact-sheet UI. A single source of truth so
// every Button, Card, Popover, bar, and modal reads from the same palette
// and spacing rhythm — the practical difference between "enterprise" and
// "slapped together" is almost entirely this file.
//
// Usage: import { colors, space, radius, … } from './tokens' in any UI
// component. Never hardcode hex values in components after this file
// lands; if a value is missing, add it here first.

export const colors = {
  // Surfaces — darkest at the bottom, lightest on top. The app sits on
  // bg.base; cards + popovers use bg.raised; nested inputs use bg.sunken.
  bg: {
    base: '#09090b',    // page background
    subtle: '#0d0d10',  // subtle section separation
    raised: '#141418',  // cards, bars, popovers
    elevated: '#1b1b22', // hover / focused card / active menu item
    sunken: '#060608',  // inputs on raised surfaces
  },

  // Borders — single-pixel lines stay consistent across every surface.
  border: {
    subtle: '#1f1f24',
    default: '#2a2a30',
    strong: '#3d3d45',
    accent: '#4f46e5',  // tinted borders for focused / active states
  },

  // Text — hierarchy, not a rainbow. Rely on weight + size for emphasis.
  text: {
    primary: '#f5f5f7',
    secondary: '#a1a1aa',
    tertiary: '#6b6b74',
    disabled: '#44444a',
    inverse: '#09090b',
  },

  // Accent — one brand color (indigo) used sparingly on primary actions
  // and focus rings. Do NOT introduce a second accent without a reason.
  accent: {
    default: '#4f46e5',
    hover: '#4338ca',
    soft: 'rgba(79, 70, 229, 0.14)',
    softHover: 'rgba(79, 70, 229, 0.22)',
    ring: 'rgba(79, 70, 229, 0.45)',
    contrast: '#ffffff',
  },

  // Semantic — success / warn / danger. Reserved exclusively for those
  // meanings (a "Render to here" button is accent, not success).
  success: {
    default: '#10b981',
    soft: 'rgba(16, 185, 129, 0.14)',
    text: '#6ee7b7',
  },
  warn: {
    default: '#f59e0b',
    soft: 'rgba(245, 158, 11, 0.14)',
    text: '#fcd34d',
  },
  danger: {
    default: '#dc2626',
    hover: '#b91c1c',
    soft: 'rgba(220, 38, 38, 0.14)',
    text: '#fca5a5',
  },
} as const;

// 4-px rhythm. Every margin, padding, and gap should round to one of
// these. If you catch yourself writing `padding: 7px`, pick 6 or 8.
export const space = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 10,
  6: 12,
  7: 14,
  8: 16,
  10: 20,
  12: 24,
  16: 32,
  20: 40,
  24: 48,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999,
} as const;

// Consistent elevation. Shadows only appear on floating surfaces
// (popovers, modals) — never on inline elements.
export const shadow = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
  md: '0 4px 12px rgba(0, 0, 0, 0.35)',
  lg: '0 16px 40px rgba(0, 0, 0, 0.55)',
  xl: '0 24px 60px rgba(0, 0, 0, 0.65)',
  ring: `0 0 0 3px ${colors.accent.ring}`,
} as const;

// Typography scale. All sizes in pixels, line-heights unitless so they
// compose cleanly with font-size cascades.
export const text = {
  h1: { fontSize: 20, lineHeight: 1.3, fontWeight: 700, letterSpacing: -0.2 },
  h2: { fontSize: 16, lineHeight: 1.35, fontWeight: 700, letterSpacing: -0.15 },
  h3: { fontSize: 14, lineHeight: 1.4, fontWeight: 600 },
  body: { fontSize: 13, lineHeight: 1.5, fontWeight: 400 },
  bodyStrong: { fontSize: 13, lineHeight: 1.5, fontWeight: 600 },
  caption: { fontSize: 11, lineHeight: 1.45, fontWeight: 500 },
  // Uppercase micro-labels used above form controls, in status bars, etc.
  eyebrow: {
    fontSize: 10,
    lineHeight: 1.2,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  },
  mono: {
    fontFamily:
      'var(--font-plex-mono), ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
} as const;

// Motion. Keep durations fast and easing consistent — "enterprise" feels
// like "immediately reacts and settles," never "whooshes."
export const motion = {
  fast: '120ms cubic-bezier(0.2, 0, 0, 1)',
  base: '180ms cubic-bezier(0.2, 0, 0, 1)',
  slow: '260ms cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const zIndex = {
  dropdown: 30,
  popover: 40,
  modal: 100,
  toast: 200,
} as const;
