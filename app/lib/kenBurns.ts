// Ken Burns motion catalog. Ten motions × three intensities = 30 presets.
// The renderer (scripts/render_from_supabase.py) ships a matching ffmpeg
// zoompan filter for each combo — keep these in sync when editing.
//
// Storage format on segment.ken_burns: "<motion>:<intensity>".
//   e.g. "center_push:high", "pan_lr:medium", "static:low"
// Legacy single-token values (push_in, zoom_in, pan_left, pan_right, zoom_out)
// still read correctly — parseKenBurns maps them to the new schema.

export type Motion =
  | 'zoom_in'
  | 'zoom_out'
  | 'center_push'
  | 'center_pull'
  | 'pan_lr'
  | 'pan_rl'
  | 'pan_tb'
  | 'pan_bt'
  | 'diagonal_push'
  | 'diagonal_pull'
  | 'parallax_drift'
  | 'static';

export type Intensity = 'low' | 'medium' | 'high';

export const MOTIONS: {
  value: Motion;
  label: string;
  hint: string;
  supportsIntensity: boolean;
}[] = [
  { value: 'zoom_in',        label: 'Zoom in',        hint: 'Original gentle push — 100% → 108%',                           supportsIntensity: false },
  { value: 'zoom_out',       label: 'Zoom out',       hint: 'Original gentle pull — 108% → 100%',                           supportsIntensity: false },
  { value: 'center_push',    label: 'Center push',    hint: 'Slow zoom into center — emphasis, tension, emotional focus',   supportsIntensity: true  },
  { value: 'center_pull',    label: 'Center pull',    hint: 'Zoom out from center — reveal context, shift perspective',     supportsIntensity: true  },
  { value: 'pan_lr',         label: 'Pan L→R',        hint: 'Horizontal sweep — scanning environment',                      supportsIntensity: true  },
  { value: 'pan_rl',         label: 'Pan R→L',        hint: 'Horizontal sweep reversed — retreat, memory',                  supportsIntensity: true  },
  { value: 'pan_tb',         label: 'Pan T→B',        hint: 'Vertical sweep down — revealing subject, hierarchy',           supportsIntensity: true  },
  { value: 'pan_bt',         label: 'Pan B→T',        hint: 'Reverse vertical reveal — rising energy',                      supportsIntensity: true  },
  { value: 'diagonal_push',  label: 'Diagonal push',  hint: 'Diagonal pan + zoom — cinematic storytelling',                 supportsIntensity: true  },
  { value: 'diagonal_pull',  label: 'Diagonal pull',  hint: 'Reverse diagonal — flashback, reflection',                     supportsIntensity: true  },
  { value: 'parallax_drift', label: 'Parallax drift', hint: 'Micro pan + micro zoom — premium cinematic feel',              supportsIntensity: true  },
  { value: 'static',         label: 'Static hold',    hint: 'No motion — reset attention, pacing control',                  supportsIntensity: false },
];

export const INTENSITIES: Intensity[] = ['low', 'medium', 'high'];

// Motion × intensity → CSS transform pair (from, to). Pans use overscaled
// zoom so the translation never reveals black edges.
//
// Keep in sync with ffmpeg filter matrix in scripts/render_from_supabase.py.
type TransformPair = { from: string; to: string };

// Transform values chosen so element always covers the 16:9 frame edge-to-edge
// at every point in the animation (constraint: scale >= 1 + 2*|translate|).
// Pans overscale enough to hide the edge reveal. Diagonals increase scale in
// lock-step with translation growth.
const MATRIX: Record<Motion, Record<Intensity, TransformPair>> = {
  // Legacy gentle variants (no intensity toggle — all three rows identical).
  zoom_in: {
    low:    { from: 'scale(1.00)', to: 'scale(1.03)' },
    medium: { from: 'scale(1.00)', to: 'scale(1.03)' },
    high:   { from: 'scale(1.00)', to: 'scale(1.03)' },
  },
  zoom_out: {
    low:    { from: 'scale(1.03)', to: 'scale(1.00)' },
    medium: { from: 'scale(1.03)', to: 'scale(1.00)' },
    high:   { from: 'scale(1.03)', to: 'scale(1.00)' },
  },
  center_push: {
    low:    { from: 'scale(1.00)', to: 'scale(1.02)' },
    medium: { from: 'scale(1.00)', to: 'scale(1.05)' },
    high:   { from: 'scale(1.00)', to: 'scale(1.10)' },
  },
  center_pull: {
    low:    { from: 'scale(1.03)', to: 'scale(1.00)' },
    medium: { from: 'scale(1.06)', to: 'scale(1.00)' },
    high:   { from: 'scale(1.12)', to: 'scale(1.00)' },
  },
  pan_lr: {
    low:    { from: 'scale(1.04) translateX(-1.5%)', to: 'scale(1.04) translateX(1.5%)' },
    medium: { from: 'scale(1.08) translateX(-3%)',   to: 'scale(1.08) translateX(3%)'   },
    high:   { from: 'scale(1.15) translateX(-6%)',   to: 'scale(1.15) translateX(6%)'   },
  },
  pan_rl: {
    low:    { from: 'scale(1.04) translateX(1.5%)', to: 'scale(1.04) translateX(-1.5%)' },
    medium: { from: 'scale(1.08) translateX(3%)',   to: 'scale(1.08) translateX(-3%)'   },
    high:   { from: 'scale(1.15) translateX(6%)',   to: 'scale(1.15) translateX(-6%)'   },
  },
  pan_tb: {
    low:    { from: 'scale(1.04) translateY(-1.5%)', to: 'scale(1.04) translateY(1.5%)' },
    medium: { from: 'scale(1.08) translateY(-3%)',   to: 'scale(1.08) translateY(3%)'   },
    high:   { from: 'scale(1.15) translateY(-6%)',   to: 'scale(1.15) translateY(6%)'   },
  },
  pan_bt: {
    low:    { from: 'scale(1.04) translateY(1.5%)', to: 'scale(1.04) translateY(-1.5%)' },
    medium: { from: 'scale(1.08) translateY(3%)',   to: 'scale(1.08) translateY(-3%)'   },
    high:   { from: 'scale(1.15) translateY(6%)',   to: 'scale(1.15) translateY(-6%)'   },
  },
  diagonal_push: {
    low:    { from: 'scale(1.00) translate(0%, 0%)', to: 'scale(1.05) translate(-1%, -1%)' },
    medium: { from: 'scale(1.00) translate(0%, 0%)', to: 'scale(1.08) translate(-2%, -2%)' },
    high:   { from: 'scale(1.00) translate(0%, 0%)', to: 'scale(1.15) translate(-4%, -4%)' },
  },
  diagonal_pull: {
    low:    { from: 'scale(1.05) translate(-1%, -1%)', to: 'scale(1.00) translate(0%, 0%)' },
    medium: { from: 'scale(1.08) translate(-2%, -2%)', to: 'scale(1.00) translate(0%, 0%)' },
    high:   { from: 'scale(1.15) translate(-4%, -4%)', to: 'scale(1.00) translate(0%, 0%)' },
  },
  parallax_drift: {
    low:    { from: 'scale(1.03) translateX(-0.5%)', to: 'scale(1.03) translateX(0.5%)' },
    medium: { from: 'scale(1.05) translateX(-1.5%)', to: 'scale(1.05) translateX(1.5%)' },
    high:   { from: 'scale(1.08) translateX(-2.5%)', to: 'scale(1.08) translateX(2.5%)' },
  },
  static: {
    low:    { from: 'scale(1.00)', to: 'scale(1.00)' },
    medium: { from: 'scale(1.00)', to: 'scale(1.00)' },
    high:   { from: 'scale(1.00)', to: 'scale(1.00)' },
  },
};

export function getTransformPair(motion: Motion, intensity: Intensity): TransformPair {
  return MATRIX[motion]?.[intensity] ?? MATRIX.center_push.medium;
}

// Legacy single-token values stored by earlier versions of the picker.
// zoom_in/zoom_out are first-class motions now so they're NOT remapped; the
// other three legacy tokens map to their closest new motion+intensity.
const LEGACY_MAP: Record<string, { motion: Motion; intensity: Intensity }> = {
  push_in:   { motion: 'center_push', intensity: 'medium' },
  pan_right: { motion: 'pan_lr',      intensity: 'medium' },
  pan_left:  { motion: 'pan_rl',      intensity: 'medium' },
  zoom_in:   { motion: 'zoom_in',     intensity: 'medium' },
  zoom_out:  { motion: 'zoom_out',    intensity: 'medium' },
};

export function parseKenBurns(raw: string | null | undefined): { motion: Motion; intensity: Intensity } {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return { motion: 'center_push', intensity: 'medium' };
  if (s in LEGACY_MAP) return LEGACY_MAP[s];
  const [m, i] = s.split(':').map((x) => x.trim());
  const motion = (MOTIONS.find((x) => x.value === m)?.value ?? 'center_push') as Motion;
  const intensity = (INTENSITIES.includes(i as Intensity) ? (i as Intensity) : 'medium');
  return { motion, intensity };
}

export function serializeKenBurns(motion: Motion, intensity: Intensity): string {
  return `${motion}:${intensity}`;
}

export function labelFor(motion: Motion): string {
  return MOTIONS.find((x) => x.value === motion)?.label ?? motion;
}
