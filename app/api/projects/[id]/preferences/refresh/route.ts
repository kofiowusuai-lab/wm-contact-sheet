// POST /api/projects/{id}/preferences/refresh
//   Reads the project's changelog + contextual files, asks Gemini to mine a
//   user-preferences profile, writes it to preferences.json. Returns the
//   fresh profile.

import { createClient } from '@supabase/supabase-js';
import { getPrompts, getTimeline, getScript, readJson } from '@/app/lib/blob';
import { readLog, appendChange, type ChangeEvent } from '@/app/lib/changelog';
import { geminiGenerate, type GeminiImageInput } from '@/app/lib/gemini';

export const runtime = 'nodejs';
// 24000-token Gemini responses on heavy-QA projects routinely take 45–80s.
// 60s timed out EP05 mid-stream; 180s leaves headroom without straining
// Vercel Pro's 300s function cap. Vision-diff Gemini calls add ~10–25s on
// top per 8-pair batch.
export const maxDuration = 240;

type Ctx = { params: Promise<{ id: string }> };

// Cap how many before/after asset pairs go into a single Gemini call. Each
// pair is two inlineData parts (image or audio). 8 pairs × ~600 vision tokens
// each ≈ 10k input tokens — well within gemini-2.5-flash's window. If the
// changelog has more unprocessed image-diff events, the route returns
// `more_pending: true` and the puller drains in additional ticks.
const MAX_DIFF_PAIRS_PER_CALL = 8;

// Image/audio events the vision-diff path mines. text-only events
// (prompt.update, segment.lock, approve, etc.) stay in the holistic
// text-only Gemini call, which is preserved unchanged below.
const VISION_DIFF_EVENT_TYPES = new Set([
  'frame.generate',
  'frame.paste',
  'frame.upload',
  'frame.clear',
  'voiceover.change',
  'voiceover.append',
]);

type DiffSpec = {
  index: number;        // 1-based, used as anchor in the prompt body
  event: ChangeEvent;
  beforeUrl: string | null;
  afterUrl: string | null;
  isAudio: boolean;
  segmentNarration?: string;
  storedPrompt?: string;
};

const VISION_DIFF_SYSTEM_PROMPT = `You are a vision-diff analyst for a video-generation contact sheet.

You will receive a sequence of BEFORE/AFTER asset pairs. Each pair represents one user-driven change to one segment in one episode (e.g. "user pasted a custom frame over the generated one", "user cleared the frame entirely", "user regenerated the voiceover with different settings"). The text body lists each diff with its event metadata; the inlineData parts that follow are the BEFORE and AFTER assets in order — pair index N's BEFORE is the (2N-2)th inlineData part, its AFTER is the (2N-1)th.

For each diff, your job is:
  1. Identify EVERY visual or auditory difference between before and after — composition, lighting, framing, character pose, wardrobe, expression, on-screen text, color palette, background detail; for audio diffs: pacing, prosody, voice identity, intonation, volume, pause distribution.
  2. Infer the user's preference rule from those differences. Each rule must be one imperative sentence applicable to FUTURE prompt + script work in this series.

Return STRICT JSON of this shape:
{
  "diffs": [
    {
      "diff_index": 1,
      "visual_observation": "Single sentence summarizing what changed.",
      "rules": [
        {
          "topic": "composition|lighting|wardrobe|expression|pacing|voice|background|character|subject_focus|...",
          "rule": "Single imperative sentence the next prompt-author / script-writer should follow.",
          "confidence": 0.0-1.0,
          "evidence_count": 1
        }
      ]
    }
  ]
}

confidence 0.9+: the diff makes a SPECIFIC change that's hard to mistake (e.g. swapped tight portrait for wide).
confidence 0.6-0.8: a plausible but ambiguous preference (e.g. slightly different lighting).
< 0.5: omit the rule entirely.

Return ONLY JSON. No markdown fences, no commentary.`;

const SYSTEM_PROMPT = `You are a prompt-learning analyst for a video-generation contact sheet.

You'll receive:
  1. A NARRATIVE CONTEXT: the project's script, the per-segment prompts the user saved, and the segment timeline.
  2. A CHANGELOG: JSONL events showing everything the user did — which prompts they rewrote, which frames they pasted vs generated, which versions they undid, which they approved, etc.

Your job: infer a STABLE PREFERENCE PROFILE that captures WHAT this user actually wants that diverges from the default model behavior. Focus on concrete, actionable rules a future prompt generator could apply blindly. Avoid generic observations.

Good rules:
  - "Avoid smiles in any loss/fired/walked-out beat; use stoic, downcast, hollow, jaw-set instead."
  - "Prefer dusk/low-lamp interiors over bright daylight."
  - "Protagonist is a young-to-middle-aged man with dark curly hair; keep this identity consistent."
  - "Wide 16:9 composition with environment flanking the character; avoid centered portrait framing with empty bars."

Bad rules (too vague):
  - "User likes anime" (obvious from the system)
  - "User wants good quality" (meaningless)

Return STRICT JSON matching:
{
  "summary": "1-3 sentence human-readable distillation of the user's taste.",
  "rules": [
    { "topic": "expression|background|character|composition|wardrobe|lighting|subject_focus|paste_patterns|...",
      "rule": "single imperative sentence",
      "confidence": 0.0-1.0,
      "evidence_count": integer,
      "examples": ["short note citing specific segments or events, optional"]
    }
  ]
}

confidence 0.9+: seen as a pattern in 3+ distinct edits.
confidence 0.6-0.8: plausible from 1-2 edits.
< 0.5: omit.

Return ONLY JSON. No markdown fences, no commentary.`;

// --- Vision diff helpers ---------------------------------------------------

function pickBeforeUrl(ev: ChangeEvent): string | null {
  // Prefer the never-overwritten snapshot. Fall back to frame_url for legacy
  // events emitted before the snapshot path shipped — those URLs may resolve
  // to the latest bytes (so the diff is degenerate), but Gemini's confidence
  // gate will reject low-signal diffs.
  const before = (ev.before ?? null) as Record<string, unknown> | null;
  if (!before) return null;
  const snap = typeof before.snapshot_url === 'string' ? before.snapshot_url : null;
  if (snap) return snap;
  const frame = typeof before.frame_url === 'string' ? before.frame_url : null;
  const vo = typeof before.voiceover_url === 'string' ? before.voiceover_url : null;
  return frame || vo || null;
}

function pickAfterUrl(ev: ChangeEvent): string | null {
  const after = (ev.after ?? null) as Record<string, unknown> | null;
  if (!after) return null;
  const frame = typeof after.frame_url === 'string' ? after.frame_url : null;
  const vo = typeof after.voiceover_url === 'string' ? after.voiceover_url : null;
  return frame || vo || null;
}

function isAudioEvent(type: string): boolean {
  return type.startsWith('voiceover.');
}

/** Returns the never-overwritten snapshot URL only — frame_url is the volatile
 *  pointer that gets overwritten in-place, so it's useless for diff. */
function pickBeforeSnapshotUrl(ev: ChangeEvent): string | null {
  const before = (ev.before ?? null) as Record<string, unknown> | null;
  if (!before) return null;
  return typeof before.snapshot_url === 'string' ? before.snapshot_url : null;
}

/** Walk the changelog newest-first, return the next batch of unprocessed
 *  vision-diff events oldest-first (so we drain in chronological order).
 *
 *  IMPORTANT — legacy event handling: events emitted before the snapshot
 *  path shipped (2026-04-29) have `before.frame_url` but no
 *  `before.snapshot_url`. Their frame_url now resolves to the SAME bytes as
 *  the after_url (Supabase upsert overwrote in place), so any diff would
 *  be degenerate and waste Gemini tokens. We skip them entirely AND advance
 *  the cursor past them so we don't re-walk them on future ticks. Vision
 *  learning is therefore forward-only from the deploy timestamp.
 */
function selectVisionDiffs(
  log: ChangeEvent[],
  processedDiffTs: string,
  cap: number,
  timeline: Array<{ id: string; narration?: string }>,
  prompts: Record<string, { prompt?: string }>,
): { batch: DiffSpec[]; morePending: boolean; newestProcessed: string } {
  const candidates: ChangeEvent[] = [];
  // Track the newest ts we walked PAST, even if filtered out — that becomes
  // the cursor advance, so legacy events without snapshot_url don't keep
  // showing up next tick.
  let newestWalkedTs = processedDiffTs;
  for (const ev of log) {
    const ts = (ev.ts || '').trim();
    if (!ts || ts <= processedDiffTs) continue;
    if (ts > newestWalkedTs) newestWalkedTs = ts;
    if (!VISION_DIFF_EVENT_TYPES.has(ev.type)) continue;
    if (ev.type !== 'frame.clear' && !pickAfterUrl(ev)) continue;
    // Strict: must have a snapshot_url for the BEFORE side. Legacy events
    // without one are skipped — but newestWalkedTs already counted them
    // above so the cursor advances past them.
    if (!pickBeforeSnapshotUrl(ev)) continue;
    candidates.push(ev);
  }
  // Sort oldest-first
  candidates.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const batch = candidates.slice(0, cap);
  const morePending = candidates.length > cap;
  const batchSpecs: DiffSpec[] = batch.map((ev, i) => {
    const seg = ev.seg_id ? timeline.find((s) => s.id === ev.seg_id) : undefined;
    const promptEntry = ev.seg_id ? prompts[ev.seg_id] : undefined;
    return {
      index: i + 1,
      event: ev,
      beforeUrl: pickBeforeSnapshotUrl(ev),
      afterUrl: pickAfterUrl(ev),
      isAudio: isAudioEvent(ev.type),
      segmentNarration: seg?.narration,
      storedPrompt: typeof promptEntry?.prompt === 'string' ? promptEntry.prompt : undefined,
    };
  });
  // Advance the cursor to whichever is newer:
  //   - the newest ts we batched (so next tick picks up after this batch), OR
  //   - the newest ts we walked past (so legacy events don't haunt us).
  // If we have a full batch with morePending, we cap at the batch's last ts
  // so the next tick picks up the very next candidate. Otherwise we jump
  // past all walked events.
  const lastBatchTs = batch.length ? (batch[batch.length - 1].ts || '') : '';
  const newestProcessed = morePending && lastBatchTs ? lastBatchTs : newestWalkedTs;
  return { batch: batchSpecs, morePending, newestProcessed };
}

function buildVisionDiffPrompt(specs: DiffSpec[], projectId: string, seriesPrefix: string): string {
  const N = specs.length;
  const lines: string[] = [];
  lines.push(`PROJECT: ${projectId}`);
  lines.push(`SERIES: ${seriesPrefix}`);
  lines.push(`COUNT: ${N} diff${N === 1 ? '' : 's'}`);
  lines.push('');
  for (const s of specs) {
    const opTag = (s.event.meta && typeof s.event.meta.op === 'string') ? s.event.meta.op : null;
    const headerExtra = opTag ? ` (meta.op: ${opTag})` : '';
    lines.push(`DIFF ${s.index} of ${N}`);
    lines.push(`  Event: ${s.event.type}${headerExtra}`);
    lines.push(`  ts: ${s.event.ts}`);
    if (s.event.seg_id) lines.push(`  seg_id: ${s.event.seg_id}`);
    if (s.segmentNarration) lines.push(`  narration: ${JSON.stringify(s.segmentNarration.slice(0, 240))}`);
    if (s.storedPrompt) lines.push(`  stored_prompt: ${JSON.stringify(s.storedPrompt.slice(0, 320))}`);
    if (s.event.type === 'frame.clear') {
      lines.push(`  asset: see [BEFORE ${s.index}] (after = deletion, no AFTER asset)`);
    } else {
      const kind = s.isAudio ? 'audio' : 'image';
      lines.push(`  asset: see [BEFORE ${s.index}] and [AFTER ${s.index}] (${kind})`);
    }
    lines.push('');
  }
  lines.push('Identify every visual / auditory difference for each diff and produce rules per the JSON schema in the system instruction.');
  return lines.join('\n');
}

async function runVisionDiffs(
  specs: DiffSpec[],
  projectId: string,
  seriesPrefix: string,
): Promise<Array<Record<string, unknown>>> {
  if (!specs.length) return [];
  // Build the inlineData sequence: [BEFORE 1, AFTER 1, BEFORE 2, AFTER 2, ...].
  // For frame.clear, only BEFORE is included; we still keep the [BEFORE N]
  // anchor in the prompt so Gemini matches the right ordinal.
  const images: GeminiImageInput[] = [];
  for (const s of specs) {
    if (s.beforeUrl) images.push({ url: s.beforeUrl });
    if (s.afterUrl) images.push({ url: s.afterUrl });
  }
  const prompt = buildVisionDiffPrompt(specs, projectId, seriesPrefix);
  let raw: string;
  try {
    raw = await geminiGenerate(prompt, {
      system: VISION_DIFF_SYSTEM_PROMPT,
      json: true,
      temperature: 0.3,
      maxOutputTokens: 8192,
      images,
    });
  } catch (e) {
    // Fail-open: vision diff is additive learning. If Gemini Vision fails,
    // text-only rules from the holistic call still produce useful output.
    // eslint-disable-next-line no-console
    console.warn(`[vision-diff] gemini failed: ${(e as Error)?.message}`);
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const stripped = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[vision-diff] Gemini output not parseable JSON');
      return [];
    }
  }
  const diffs: any[] = Array.isArray(parsed?.diffs) ? parsed.diffs : [];
  const out: Array<Record<string, unknown>> = [];
  for (const d of diffs) {
    const idx = Number(d?.diff_index);
    const spec = specs.find((s) => s.index === idx);
    if (!spec) continue;
    const visualObservation = typeof d?.visual_observation === 'string' ? d.visual_observation : '';
    const ruleArr: any[] = Array.isArray(d?.rules) ? d.rules : [];
    for (const r of ruleArr) {
      const ruleText = typeof r?.rule === 'string' ? r.rule.trim() : '';
      if (!ruleText) continue;
      const conf = Number(r?.confidence);
      if (!isFinite(conf) || conf < 0.5) continue;
      out.push({
        topic: typeof r?.topic === 'string' ? r.topic : '',
        rule: ruleText,
        confidence: conf,
        evidence_count: Math.max(1, Number(r?.evidence_count) || 1),
        // Carries the source event + visual observation through to the puller
        // (sync_preferences.py reads these and forwards to log_feedback.py
        // which lands them in the vault frontmatter).
        source_event: {
          type: spec.event.type,
          seg_id: spec.event.seg_id,
          ts: spec.event.ts,
          before_snapshot: spec.beforeUrl,
          after_url: spec.afterUrl,
          op: (spec.event.meta && typeof spec.event.meta.op === 'string') ? spec.event.meta.op : null,
        },
        visual_observation: visualObservation,
      });
    }
  }
  return out;
}

export async function POST(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!process.env.GEMINI_API_KEY) {
      return Response.json({ error: 'GEMINI_API_KEY missing' }, { status: 500 });
    }

    // Gather context: script, prompts, timeline, and full changelog.
    const [script, prompts, timeline, log] = await Promise.all([
      getScript(id),
      getPrompts(id),
      getTimeline(id),
      readLog(id),
    ]);

    const contextPayload = {
      script: script ?? '',
      prompts,
      timeline: (timeline ?? []).map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        narration: s.narration,
        kind: s.kind,
      })),
    };

    // Cap the changelog passed to Gemini. Heavy QA projects (EP004 of
    // Constantly Unemployed had 526 frame.generate + 159 frame.undo events)
    // produce changelogs that overflow Gemini's output — the model wants to
    // emit one rule per pattern and gets cut off mid-string. Newest-first
    // truncation keeps the most recent intent (Casper's latest QA pass) and
    // discards stale undos that no longer reflect the working preference.
    const MAX_CHANGELOG_EVENTS = 250;
    const fullLog = log.slice().reverse(); // newest first
    const trimmedLog = fullLog.slice(0, MAX_CHANGELOG_EVENTS);
    const trimmed = fullLog.length > MAX_CHANGELOG_EVENTS;

    const userPrompt = [
      'NARRATIVE CONTEXT (JSON):',
      JSON.stringify(contextPayload, null, 2),
      '',
      `CHANGELOG (${log.length} events total${
        trimmed ? `, showing newest ${MAX_CHANGELOG_EVENTS}` : ''
      }, newest first):`,
      JSON.stringify(trimmedLog, null, 2),
    ].join('\n');

    const raw = await geminiGenerate(userPrompt, {
      system: SYSTEM_PROMPT,
      json: true,
      temperature: 0.3,
      // 24000 covers ~50 rules at ~80 tokens each. 6000 truncated mid-string
      // on heavy-QA projects (526+ events). Gemini 2.5 Flash supports up to
      // 65536 output tokens; 24k is generous without being wasteful.
      maxOutputTokens: 24000,
    });

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (firstErr) {
      // Two recovery paths before giving up:
      //  1. Strip a stray ```json ... ``` markdown wrap.
      //  2. If JSON is truncated mid-array, repair by closing the array. The
      //     SYSTEM_PROMPT shape is { summary, rules: [...] } — most recoverable
      //     truncation lands inside the rules array. Find the last complete
      //     rule object and re-close.
      const stripped = raw.replace(/^```json\s*|\s*```$/g, '').trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        const lastCompleteRule = stripped.lastIndexOf('}\n  ,');
        if (lastCompleteRule > 0) {
          const repaired = stripped.slice(0, lastCompleteRule + 1) + '\n  ]\n}';
          parsed = JSON.parse(repaired);
        } else {
          // Unrecoverable; surface the original error.
          throw firstErr;
        }
      }
    }

    // --- Vision-diff pass -------------------------------------------------
    // Read the prior preferences.json to find the cursor of the last vision
    // diff we processed. New events past that cursor (up to MAX_DIFF_PAIRS)
    // get fed to Gemini as before/after pairs. The rest get a more_pending
    // flag so the puller drains them in subsequent ticks.
    const priorPrefs = (await readJson<{ processed_diff_ts?: string }>(`projects/${id}/preferences.json`)) || {};
    const processedDiffTs = priorPrefs.processed_diff_ts || '';
    const seriesPrefix = id.split('__')[0] || id.split('_')[0] || '';
    const { batch, morePending, newestProcessed } = selectVisionDiffs(
      log,
      processedDiffTs,
      MAX_DIFF_PAIRS_PER_CALL,
      timeline ?? [],
      prompts,
    );
    const visionRules = await runVisionDiffs(batch, id, seriesPrefix);
    const nextProcessedDiffTs = batch.length ? newestProcessed : processedDiffTs;

    const finalDoc = {
      summary: String(parsed?.summary || '').slice(0, 2000),
      // Vision-diff rules come first so the puller sees them as the most
      // recent, fresh signal — but they go through the same dedup hash
      // (sha1(project_id|rule_text)[:16]) so duplicates with the holistic
      // pass don't double-write.
      rules: [
        ...visionRules,
        ...(Array.isArray(parsed?.rules) ? parsed.rules : []),
      ],
      updated_at: new Date().toISOString(),
      events_analyzed: log.length,
      vision_diffs_processed: batch.length,
      vision_rules_emitted: visionRules.length,
      processed_diff_ts: nextProcessedDiffTs,
      more_pending: morePending,
      model: 'gemini-2.5-flash',
    };

    // Persist
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const bucket = process.env.SUPABASE_BUCKET || 'wm-contact-sheet';
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const blob = new Blob([JSON.stringify(finalDoc, null, 2)], { type: 'application/json' });
    await sb.storage
      .from(bucket)
      .upload(`projects/${id}/preferences.json`, blob, { upsert: true, cacheControl: '0' });

    await appendChange(id, {
      type: 'preferences.refreshed',
      meta: {
        events_analyzed: log.length,
        rule_count: finalDoc.rules.length,
        vision_diffs_processed: batch.length,
        vision_rules_emitted: visionRules.length,
        more_pending: morePending,
      },
    });

    // Promote portable rules to the global store so every other project
    // benefits. Runs in-process (not fire-and-forget) so the response can
    // report how many rules crossed over — but swallow errors to keep the
    // project-level refresh authoritative even if the promotion step breaks.
    let globalPromotion: { promoted: number; merged: number } | null = null;
    try {
      const origin = new URL(_.url).origin;
      const pr = await fetch(`${origin}/api/global/preferences/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: id }),
      });
      if (pr.ok) {
        const pj = await pr.json();
        globalPromotion = { promoted: pj.promoted ?? 0, merged: pj.merged ?? 0 };
      }
    } catch {
      /* non-fatal */
    }

    return Response.json({ ...finalDoc, global_promotion: globalPromotion });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 400) }, { status: 500 });
  }
}
