'use client';

// Lightweight responsive hook. Returns whether the current viewport matches
// the given media query. SSR-safe: returns the initial value until hydrated.

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

// Shared breakpoints.
export const BP = {
  // Small phones (iPhone SE / mini range). Used for the tightest overrides —
  // full-width buttons in bulk action bars, hidden decorative spacers,
  // single-line truncation on the lightbox caption, etc.
  narrowPhone: '(max-width: 480px)',
  mobile: '(max-width: 640px)',
  tablet: '(max-width: 1024px)',
  // "Narrow desktop" — the window is too tight for the full multi-button row
  // but too wide to use the mobile-stacked layout. Used to switch row meta
  // controls to compact mode (smaller buttons, truncated picker labels).
  narrowDesktop: '(min-width: 641px) and (max-width: 1180px)',
} as const;

export function useIsNarrowPhone() {
  return useMediaQuery(BP.narrowPhone, false);
}
export function useIsMobile() {
  return useMediaQuery(BP.mobile, false);
}
export function useIsTablet() {
  return useMediaQuery(BP.tablet, false);
}
export function useIsNarrowDesktop() {
  return useMediaQuery(BP.narrowDesktop, false);
}
