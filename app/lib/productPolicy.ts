// Decide whether a given segment should receive product placement
// (product_notes + product reference images).
//
// Rule:
//   - If any segments have kind === 'end_card', those are the product frames.
//     This lets a project with multiple end cards (e.g. EC_01 + EC_02) show the
//     product on each.
//   - Otherwise, fall back to the single last segment in timeline order.

import type { Segment } from './blob';

export function shouldIncludeProduct(
  seg: Pick<Segment, 'id' | 'kind'>,
  allSegments: Array<Pick<Segment, 'id' | 'kind' | 'start'>>,
): boolean {
  const explicitEnds = allSegments.filter((s) => s.kind === 'end_card');
  if (explicitEnds.length > 0) {
    return explicitEnds.some((s) => s.id === seg.id);
  }
  const sorted = [...allSegments].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const last = sorted[sorted.length - 1];
  return !!last && last.id === seg.id;
}
