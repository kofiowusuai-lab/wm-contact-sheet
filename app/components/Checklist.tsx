'use client';

// "What do I do next?" tracker pinned under the Series/Episode bar.
// Six steps, state inferred from the current bundle — we never ask the
// user to mark anything done, we show truth.
//
// Clicking a step doesn't mutate state. It opens the relevant panel and
// scrolls it into view, so a new user always has a clear next action
// instead of staring at an array of inputs and guessing.

import { Check, Circle, ArrowRight } from 'lucide-react';
import type { ProjectMeta, Segment } from '../lib/blob';
import { useIsMobile } from '../lib/useMediaQuery';
import { colors, radius, space, text } from './ui';

type BundleForChecklist = {
  script: string | null;
  meta: ProjectMeta;
  timeline: Segment[] | null;
  voiceover_url: string | null;
};

export type ChecklistTarget =
  | 'series'
  | 'script'
  | 'voice'
  | 'aspect'
  | 'voiceover'
  | 'frames';

export type ChecklistProps = {
  activeSeriesId: string;
  activeEpisodeId: string;
  bundle: BundleForChecklist | null;
  onScrollTo: (target: ChecklistTarget) => void;
};

export type Step = {
  id: ChecklistTarget;
  label: string;
  done: boolean;
  hint: string;
};

/** Map of checklist boolean state → high-level stage.
 *  Used by ContactSheet to set stage-aware defaults (e.g., which panels
 *  are collapsed on first project open). Established projects land at
 *  tier 3 naturally because all six checklist steps are already done. */
export type Tier = 0 | 1 | 2 | 3;
export function deriveTier(steps: Step[]): Tier {
  // Step indexes (0-based) from computeSteps:
  //   0: series + episode picked
  //   4: voiceover ready
  //   5: frames ready
  if (!steps[0]?.done) return 0;
  if (!steps[4]?.done) return 1;
  if (!steps[5]?.done) return 2;
  return 3;
}

export function computeSteps(
  activeSeriesId: string,
  activeEpisodeId: string,
  bundle: BundleForChecklist | null,
): Step[] {
  const hasSeriesAndEp = !!activeSeriesId && !!activeEpisodeId;
  const scriptLen = bundle?.script?.trim().length ?? 0;
  const voiceId = bundle?.meta?.voice_id;
  const aspect = bundle?.meta?.aspect;
  const timeline = bundle?.timeline ?? [];
  const voiceoverReady = !!bundle?.voiceover_url && timeline.length > 0;
  const framed = timeline.filter((s) => s.frame_url).length;
  const framesReady = timeline.length > 0 && framed / timeline.length >= 0.9;

  return [
    {
      id: 'series',
      label: 'Pick Series + Episode',
      done: hasSeriesAndEp,
      hint: hasSeriesAndEp ? 'Both dropdowns are set.' : 'Use the Series and Episode dropdowns above.',
    },
    {
      id: 'script',
      label: 'Paste script',
      done: scriptLen >= 40,
      hint:
        scriptLen === 0
          ? 'Open Script + Voice and paste your narration.'
          : scriptLen < 40
            ? 'Script looks short — add the rest.'
            : `${scriptLen.toLocaleString()} characters.`,
    },
    {
      id: 'voice',
      label: 'Pick voice',
      done: !!voiceId,
      hint: voiceId ? `Selected: ${bundle?.meta?.voice_name || voiceId}` : 'Browse library — 11k+ voices.',
    },
    {
      id: 'aspect',
      label: 'Lock aspect',
      done: !!aspect,
      hint: aspect ? `Aspect: ${aspect}` : 'Pick 16:9, 9:16, 1:1, or 4:5.',
    },
    {
      id: 'voiceover',
      label: 'Generate voiceover',
      done: voiceoverReady,
      hint: voiceoverReady
        ? `${timeline.length} segments, voiceover ready.`
        : 'Hit Generate voiceover + timeline once 2–4 are done.',
    },
    {
      id: 'frames',
      label: 'Generate frames',
      done: framesReady,
      hint:
        timeline.length === 0
          ? 'Runs after step 5.'
          : `${framed}/${timeline.length} frames${framesReady ? ' — ready to render.' : '.'}`,
    },
  ];
}

export default function Checklist({
  activeSeriesId,
  activeEpisodeId,
  bundle,
  onScrollTo,
}: ChecklistProps) {
  const isMobile = useIsMobile();
  const steps = computeSteps(activeSeriesId, activeEpisodeId, bundle);
  const activeIdx = steps.findIndex((s) => !s.done);
  const allDone = activeIdx === -1;

  return (
    <div
      style={{
        marginTop: space[5],
        padding: space[5],
        background: colors.bg.raised,
        border: `1px solid ${colors.border.subtle}`,
        borderRadius: radius.lg,
        display: 'flex',
        flexDirection: 'column',
        gap: space[5],
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: space[5],
        }}
      >
        <span style={{ ...text.eyebrow, color: colors.text.secondary }}>Checklist</span>
        <span
          style={{
            ...text.caption,
            color: allDone ? colors.success.text : colors.accent.default,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: space[2],
          }}
        >
          {allDone ? (
            <>
              <Check size={12} strokeWidth={3} /> Ready to render
            </>
          ) : (
            <>
              <ArrowRight size={12} strokeWidth={2.5} />
              Next · {steps[activeIdx].label}
            </>
          )}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)',
          gap: space[3],
        }}
      >
        {steps.map((s, i) => {
          const isActive = i === activeIdx;
          const stepStyle = s.done
            ? stepStyles.done
            : isActive
              ? stepStyles.active
              : stepStyles.pending;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onScrollTo(s.id)}
              className="wm-btn"
              data-variant="ghost"
              style={{
                ...stepStyle,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: space[2],
                padding: space[4],
                borderRadius: radius.md,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                minHeight: 60,
              }}
              title={s.hint}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: space[2],
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: stepStyle.color,
                }}
              >
                <StepIcon done={s.done} active={isActive} index={i} />
                Step {i + 1}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: stepStyle.labelColor }}>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepIcon({ done, active, index }: { done: boolean; active: boolean; index: number }) {
  if (done) return <Check size={12} strokeWidth={3} />;
  if (active) return <ArrowRight size={12} strokeWidth={2.5} />;
  return <Circle size={10} strokeWidth={2} />;
}

const stepStyles: Record<'done' | 'active' | 'pending', React.CSSProperties & { labelColor: string }> = {
  done: {
    background: colors.success.soft,
    border: `1px solid rgba(16, 185, 129, 0.28)`,
    color: colors.success.text,
    labelColor: colors.text.primary,
  },
  active: {
    background: colors.accent.soft,
    border: `1px solid ${colors.accent.default}`,
    color: colors.accent.default,
    boxShadow: `0 0 0 3px ${colors.accent.softHover}`,
    labelColor: colors.text.primary,
  },
  pending: {
    background: colors.bg.elevated,
    border: `1px solid ${colors.border.subtle}`,
    color: colors.text.tertiary,
    labelColor: colors.text.secondary,
  },
};
