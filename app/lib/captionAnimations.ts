// 30-animation caption library. Keep the `id` list in lockstep with
// scripts/render_from_supabase.py's animation switch, otherwise the
// browser preview and baked MP4 diverge.
//
//   - kind='block'    → whole caption gets one CSS animation (or one ASS
//                        \t/\move/\fad tag). Cheap, works without
//                        words.json.
//   - kind='per_word' → the overlay splits text into <span>s and staggers
//                        the animation by each word's Whisper timestamp.
//                        Falls back to even-split when words.json is
//                        missing.

export type CaptionAnimationId =
  | 'none'
  // Entrance / block
  | 'fade' | 'slide_up' | 'slide_down' | 'slide_left' | 'slide_right'
  | 'zoom_in' | 'zoom_out' | 'roll_in'
  // Block emphasis
  | 'stamp' | 'rubber' | 'neon_flicker' | 'shake'
  // Block looping
  | 'pulse' | 'gradient_sweep'
  // Per-word reveal
  | 'typewriter' | 'typewriter_cursor'
  | 'word_by_word' | 'karaoke' | 'karaoke_fill'
  | 'word_bounce' | 'word_spring' | 'word_flip' | 'word_rotate'
  // Per-word kinetic
  | 'pop' | 'word_wave' | 'word_glitch' | 'bubble'
  | 'wave_color' | 'tiktok_highlight' | 'hopper';

export type AnimationCategory = 'entrance' | 'emphasis' | 'loop' | 'reveal' | 'kinetic';

export type CaptionAnimationDef = {
  id: CaptionAnimationId;
  label: string;
  category: AnimationCategory;
  kind: 'block' | 'per_word';
  /** Named keyframe in globals.css — the overlay applies this to the
   *  element. Empty string for 'none'. */
  cssName: string;
  /** Animation timing function. Default 'ease-out' when omitted. */
  timing?: string;
  /** Base duration scalar. Actual duration = base * seg_duration, clamped
   *  in the overlay so short segments don't race and long ones don't
   *  drag. Ignored when custom = true (the overlay does the math). */
  base?: number;
  /** When true, the current word (per_word only) flashes to
   *  `highlightColor`. */
  highlightsCurrent?: boolean;
  /** When true, the animation is a continuous loop after the initial
   *  reveal (pulse, gradient_sweep, shake). */
  loop?: boolean;
};

export const CAPTION_ANIMATIONS: CaptionAnimationDef[] = [
  { id: 'none',             label: 'None',            category: 'entrance', kind: 'block',    cssName: '' },

  // --- Entrance / block ---
  { id: 'fade',             label: 'Fade in',         category: 'entrance', kind: 'block',    cssName: 'wm-cap-fade',        base: 0.4 },
  { id: 'slide_up',         label: 'Slide up',        category: 'entrance', kind: 'block',    cssName: 'wm-cap-slide-up',    base: 0.5 },
  { id: 'slide_down',       label: 'Slide down',      category: 'entrance', kind: 'block',    cssName: 'wm-cap-slide-down',  base: 0.5 },
  { id: 'slide_left',       label: 'Slide left',      category: 'entrance', kind: 'block',    cssName: 'wm-cap-slide-left',  base: 0.5 },
  { id: 'slide_right',      label: 'Slide right',     category: 'entrance', kind: 'block',    cssName: 'wm-cap-slide-right', base: 0.5 },
  { id: 'zoom_in',          label: 'Zoom in',         category: 'entrance', kind: 'block',    cssName: 'wm-cap-zoom-in',     base: 0.5, timing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'zoom_out',         label: 'Zoom out',        category: 'entrance', kind: 'block',    cssName: 'wm-cap-zoom-out',    base: 0.5 },
  { id: 'roll_in',          label: 'Roll in',         category: 'entrance', kind: 'block',    cssName: 'wm-cap-roll-in',     base: 0.6 },

  // --- Block emphasis ---
  { id: 'stamp',            label: 'Stamp',           category: 'emphasis', kind: 'block',    cssName: 'wm-cap-stamp',       base: 0.35, timing: 'cubic-bezier(0.2, 0.9, 0.3, 1.4)' },
  { id: 'rubber',           label: 'Rubber',          category: 'emphasis', kind: 'block',    cssName: 'wm-cap-rubber',      base: 0.7 },
  { id: 'neon_flicker',     label: 'Neon flicker',    category: 'emphasis', kind: 'block',    cssName: 'wm-cap-neon',        base: 0.8 },
  { id: 'shake',            label: 'Shake',           category: 'emphasis', kind: 'block',    cssName: 'wm-cap-shake',       base: 0.35, loop: true },

  // --- Block looping ---
  { id: 'pulse',            label: 'Pulse',           category: 'loop',     kind: 'block',    cssName: 'wm-cap-pulse',       base: 1.5, loop: true },
  { id: 'gradient_sweep',   label: 'Gradient sweep',  category: 'loop',     kind: 'block',    cssName: 'wm-cap-grad-sweep',  base: 2.5, loop: true },

  // --- Per-word reveal ---
  { id: 'typewriter',       label: 'Typewriter',      category: 'reveal',   kind: 'block',    cssName: 'wm-cap-typewriter',  base: 1 },
  { id: 'typewriter_cursor',label: 'Typewriter + cursor', category: 'reveal', kind: 'block', cssName: 'wm-cap-typewriter',  base: 1 },
  { id: 'word_by_word',     label: 'Word by word',    category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-fadeword' },
  { id: 'karaoke',          label: 'Karaoke',         category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-karaoke',     highlightsCurrent: true },
  { id: 'karaoke_fill',     label: 'Karaoke fill',    category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-karaoke-fill', highlightsCurrent: true },
  { id: 'word_bounce',      label: 'Word bounce',     category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-bounce' },
  { id: 'word_spring',      label: 'Word spring',     category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-spring' },
  { id: 'word_flip',        label: 'Word flip',       category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-flip' },
  { id: 'word_rotate',      label: 'Word rotate',     category: 'reveal',   kind: 'per_word', cssName: 'wm-cap-rotate' },

  // --- Per-word kinetic ---
  { id: 'pop',              label: 'Pop (CapCut)',    category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-pop',         highlightsCurrent: true },
  { id: 'word_wave',        label: 'Word wave',       category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-word-wave' },
  { id: 'word_glitch',      label: 'Glitch',          category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-glitch' },
  { id: 'bubble',           label: 'Bubble',          category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-bubble',      timing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  { id: 'wave_color',       label: 'Color wave',      category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-wave-color' },
  { id: 'tiktok_highlight', label: 'TikTok highlight', category: 'kinetic', kind: 'per_word', cssName: 'wm-cap-tiktok',      highlightsCurrent: true },
  { id: 'hopper',           label: 'Hopper',          category: 'kinetic',  kind: 'per_word', cssName: 'wm-cap-hopper' },
];

export const ANIMATIONS_BY_ID: Record<CaptionAnimationId, CaptionAnimationDef> =
  Object.fromEntries(CAPTION_ANIMATIONS.map((a) => [a.id, a])) as Record<
    CaptionAnimationId,
    CaptionAnimationDef
  >;

export const CATEGORY_LABELS: Record<AnimationCategory, string> = {
  entrance: 'Entrance',
  emphasis: 'Emphasis',
  loop: 'Looping',
  reveal: 'Per-word reveal',
  kinetic: 'Per-word kinetic',
};
