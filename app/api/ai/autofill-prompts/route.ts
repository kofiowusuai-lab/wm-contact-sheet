// POST /api/ai/autofill-prompts
//
// Body: { project_id: string, overwrite?: boolean, style_anchor?: string }
//
// Server port of ~/.openclaw/scripts/autofill-prompts.mjs. Two passes:
//   Pass 1 — group timeline into scenes by speaker-set runs + audio gaps,
//            pick one location id per scene from the series catalog.
//   Pass 2 — per-segment Gemini call with dialogue-aware shot-counter-shot,
//            using prev/next segment context + continuity hints.
//
// Idempotent: skips segments whose prompts.json already has an entry unless
// `overwrite: true`.
//
// Writes prompts.json + (if any location/speaker stamps changed) timeline.json.

import {
  getTimeline,
  getPrompts,
  getMeta,
  getScript,
  putPrompts,
  putTimeline,
  getMergedLocations,
  type Segment,
  type Location,
} from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 300;

const GEMINI_MODEL = 'gemini-2.5-flash';

// Per-series style anchors — keep in sync with the scripts/autofill-prompts.mjs
// version. For brand-new series not in this map, the orchestrator passes a
// style_anchor override in the request body.
const SERIES_STYLE: Record<string, string> = {
  ceoanimated:
    'Rendering: 2D cel-shaded anime characters over cinematic painted backgrounds, subtle film grain, 20% headroom safe zone. Palette: slightly desaturated, warm skin tones, lighting varies by scene (warm kitchen lamps for domestic interiors, halogen cool for offices, amber nightclub neon only in club scenes, overcast daylight for street exteriors). Pick lighting based on the NARRATION, not a default. No photoreal. No Pixar 3D.',
  constant_domination:
    'Rendering: archival-style documentary photograph, subtle photographic grain, shallow depth of field, editorial 2025 NYC private-equity world. Palette: warm domestic interiors for home scenes, halogen cool-light for offices, natural daylight for street exteriors, dim lamps for after-hours scenes. Pick lighting based on the NARRATION. NOT stylised illustration.',
  constantly_unemployed:
    'Rendering: cel-shaded anime character (Kody or named supporting character) over Studio-Ghibli painted backgrounds, film grain. Palette: warm natural light, green-and-ochre outdoor scenes, soft overhead fluorescents for office/bodega interiors, warm amber for home. Pick environment from the NARRATION. No photoreal. No Pixar 3D.',
  drstickmanreid:
    'Rendering: modern storybook illustration, editorial magazine style, soft painterly watercolour-and-gouache shading, textured sketchy line art, subtle grain overlay. Palette: muted earthy; warm golden-hour for exterior scenes, clinical neutral for clinic/anatomy scenes, soft interior for home. Dr Reid himself is a clean stick figure on a textured paper base while environments and anthropomorphised cast are fully painted. Pick environment from the NARRATION.',
  financebro:
    'Rendering: editorial illustration, stick-figure Finance Bro host (charcoal suit, electric-blue tie, brown brogues) on a textured paper base, film grain. Palette: midnight-navy + charcoal + gold accents for the explainer stage; warmer interior light for detour / relatable-scene frames. No Lamborghinis, no cash stacks, no cel-shaded anime. Pick the backdrop from the LOCATION or NARRATION.',
};

async function gemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 400,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 503 || r.status === 429) {
      lastErr = new Error(`${r.status} ${text.slice(0, 100)}`);
      await new Promise((res) => setTimeout(res, 1500 * attempt));
      continue;
    }
    if (!r.ok) throw new Error(`gemini ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) throw new Error(`gemini empty response: ${text.slice(0, 200)}`);
    return out;
  }
  throw lastErr ?? new Error('gemini exhausted retries');
}

// ---------- script → turn parse (lifted from autofill-prompts.mjs) ----------

type Turn = { speaker: string; text: string };

function parseScriptTurns(script: string): Turn[] {
  const lines = String(script || '').replace(/\r\n/g, '\n').split('\n');
  const turns: Turn[] = [];
  let curSpeaker = '';
  let curBuf: string[] = [];
  const flush = () => {
    const text = curBuf.join('\n').trim();
    if (text) turns.push({ speaker: curSpeaker, text });
    curBuf = [];
  };
  const tagRe = /^@([A-Za-z][A-Za-z0-9_-]*)\s*:\s+(.+)$/;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { curBuf.push(''); continue; }
    const m = tagRe.exec(trimmed);
    if (m) {
      const next = m[1].toUpperCase();
      if (next !== curSpeaker) { flush(); curSpeaker = next; }
      curBuf.push(m[2].trim());
    } else {
      if (curSpeaker !== '') { flush(); curSpeaker = ''; }
      curBuf.push(trimmed);
    }
  }
  flush();
  return turns;
}

function attributeSpeakers(timeline: Segment[], turns: Turn[]): Segment[] {
  const out = timeline.map((s) => ({ ...s }));
  let turnIdx = 0;
  let turnPos = 0;
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const seg of out) {
    if (!seg.narration || seg.kind === 'end_card') continue;
    const segText = normalise(seg.narration);
    if (!segText) continue;
    const firstWords = segText.split(' ').slice(0, 6).join(' ');
    let matchedAt = -1;
    for (let j = turnIdx; j < Math.min(turns.length, turnIdx + 4); j++) {
      const turnText = normalise(turns[j].text);
      const searchFrom = j === turnIdx ? turnPos : 0;
      const foundIdx = turnText.indexOf(firstWords, searchFrom);
      if (foundIdx >= 0) {
        matchedAt = j;
        turnIdx = j;
        turnPos = foundIdx + segText.length;
        break;
      }
    }
    if (matchedAt >= 0) {
      seg.speaker = turns[matchedAt].speaker || '';
    }
  }
  return out;
}

// ---------- scene grouping ----------

type Scene = {
  segs: Segment[];
  start: number;
  end: number;
  speakerSet: string[];
  narrationSummary: string;
};

function groupIntoScenes(timeline: Segment[]): Scene[] {
  const vos = timeline.filter((s) => s.kind !== 'end_card');
  if (vos.length === 0) return [];
  const scenes: { segs: Segment[] }[] = [];
  let currentScene: { segs: Segment[] } = { segs: [vos[0]] };
  for (let i = 1; i < vos.length; i++) {
    const prev = vos[i - 1];
    const s = vos[i];
    const prevSpeaker = prev.speaker || '';
    const curSpeaker = s.speaker || '';
    const windowA = new Set(vos.slice(Math.max(0, i - 2), i + 1).map((x) => x.speaker || ''));
    const windowB = new Set(vos.slice(i, Math.min(vos.length, i + 3)).map((x) => x.speaker || ''));
    const windowsEqual = windowA.size === windowB.size && Array.from(windowA).every((x) => windowB.has(x));
    const gap = (s.start || 0) - (prev.end || 0);
    const brokeOnGap = gap > 2.5;
    const brokeOnSpeakerShift = !windowsEqual && prevSpeaker !== curSpeaker
      && ((prevSpeaker === '' && curSpeaker !== '') || (prevSpeaker !== '' && curSpeaker === '' && currentScene.segs.filter((x) => x.speaker).length >= 4));
    if (brokeOnGap || brokeOnSpeakerShift) {
      scenes.push(currentScene);
      currentScene = { segs: [s] };
    } else {
      currentScene.segs.push(s);
    }
  }
  scenes.push(currentScene);
  return scenes.map((sc) => ({
    ...sc,
    start: sc.segs[0].start,
    end: sc.segs[sc.segs.length - 1].end,
    speakerSet: Array.from(new Set(sc.segs.map((s) => s.speaker || '').filter(Boolean))),
    narrationSummary: sc.segs.map((s) => s.narration || '').join(' ').slice(0, 800),
  }));
}

// ---------- prompt builders ----------

function inferMotion(segKind: string | undefined, segIdx: number, totalSegs: number): string {
  if (segKind === 'title_card') return 'hold';
  if (segKind === 'end_card') return 'zoom_in:slow';
  if (segIdx === 0) return 'push_in:medium';
  if (segIdx === totalSegs - 1) return 'zoom_out:slow';
  const pattern = ['zoom_in:slow', 'pan_right:slow', 'push_in:medium', 'pan_left:slow'];
  return pattern[segIdx % pattern.length];
}

function buildScenePicker(style: string, scene: Scene, locationMenu: Location[], speakers: string[]): string {
  const speakersDescription = speakers.length === 0
    ? 'Narrator only (no named characters speak in this scene)'
    : `Characters in scene: ${speakers.map((s) => '@' + s).join(', ')}`;
  return `Pick ONE location id from the menu below that best fits the scene described by the narration. A scene is a continuous dramatic unit — a conversation, a monologue over one visual, a single dramatic moment — so the WHOLE scene happens in ONE place.

SERIES CONTEXT: ${style.slice(0, 300)}

${speakersDescription}

SCENE NARRATION (${scene.segs.length} segments, ${(scene.end - scene.start).toFixed(1)}s total):
"${scene.narrationSummary}"

LOCATION MENU:
${locationMenu.slice(0, 80).map((l) => `  ${l.id} — ${l.name}${l.description ? ` (${l.description.slice(0, 60)})` : ''}`).join('\n')}

Guidance:
- Dialogue between the SAME set of characters = ONE location.
- If the narration describes one physical space, pick the id that best matches that space.
- Narrator monologue about abstract themes (time passing, decisions) — pick a location that contextualises the speaker.
- Never invent an id — pick exactly one from the menu.

Return ONLY the chosen location id as a single token. No preamble, no explanation.`;
}

type BuildPromptArgs = {
  style: string;
  aspect: string;
  seg: Segment;
  segIdx: number;
  totalSegs: number;
  locationCatalog: Map<string, Location>;
  characterTag: string | null;
  prevSeg: Segment | null;
  nextSeg: Segment | null;
  locationMenu: Location[];
};

function buildGeminiPrompt(args: BuildPromptArgs): string {
  const { style, aspect, seg, segIdx, totalSegs, locationCatalog, characterTag, prevSeg, nextSeg, locationMenu } = args;

  const hasMenu = locationMenu && locationMenu.length > 0;
  const locDescription = (() => {
    if (seg.location) {
      const loc = locationCatalog.get(seg.location);
      if (!loc) return `location id: ${seg.location}`;
      return `${loc.name || seg.location} — ${loc.description || ''}`.trim();
    }
    // When there IS a menu, push Gemini to pick from it. When there isn't,
    // let Gemini invent an appropriate environment from the narration —
    // crucially, WITHOUT mentioning a menu (otherwise Gemini echoes a
    // hallucinated menu back into the prompt body).
    return hasMenu
      ? '(no location stamped — MUST pick one id from the LOCATION MENU below)'
      : '(no location catalog for this project — invent a setting directly from the narration\'s implied environment; describe it in the Composition sentence)';
  })();
  const locationMenuBlock = hasMenu && !seg.location
    ? `\n\nLOCATION MENU (pick exactly one id — add a line "LOCATION_ID: <id>" at the very top of your output, then the prompt body):\n${locationMenu.slice(0, 80).map((l) => `  ${l.id} — ${l.name}${l.description ? ` (${l.description.slice(0, 60)})` : ''}`).join('\n')}`
    : '';
  const whoInFrame = characterTag
    ? `The character "${characterTag}" is on screen (use the character reference image)`
    : (seg.kind === 'end_card' ? 'End-card frame — product/CTA placement'
       : (seg.kind === 'title_card' ? 'Title card — text overlay over backdrop'
          : 'No specific character — scene/environment only OR the series default host'));

  const motion = seg.ken_burns || inferMotion(seg.kind, segIdx, totalSegs);

  const prevSpeaker = prevSeg?.speaker || '';
  const nextSpeaker = nextSeg?.speaker || '';
  const thisSpeaker = seg.speaker || '';
  let continuityHint = '';
  if (thisSpeaker && prevSpeaker && thisSpeaker !== prevSpeaker) {
    continuityHint = `SHOT-COUNTER-SHOT: Previous beat was @${prevSpeaker} speaking. This beat is @${thisSpeaker} responding — cut to a CLOSE or MEDIUM-CLOSE of @${thisSpeaker} reacting. Keep the SAME location and visual style as the previous beat to maintain continuity.`;
  } else if (thisSpeaker && thisSpeaker === prevSpeaker) {
    continuityHint = `CONTINUITY: Same speaker (@${thisSpeaker}) as the previous beat. Keep the same location and lighting, but vary framing slightly (e.g. push in tighter, or change angle). Don't cut to a new scene.`;
  } else if (!thisSpeaker && !prevSpeaker && prevSeg) {
    continuityHint = `NARRATOR CONTINUITY: Still narrator prose, same scene as the previous beat. Evolve the composition (closer detail, different object in the same space) rather than cutting to a new location.`;
  } else if (thisSpeaker && !prevSpeaker) {
    continuityHint = `SCENE ENTRY: Narrator just handed off to character @${thisSpeaker}. Open on a WIDE or MEDIUM establishing the scene with @${thisSpeaker} clearly visible, then the next beat can cut in closer.`;
  } else if (!thisSpeaker && prevSpeaker) {
    continuityHint = `SCENE EXIT: Character dialogue ended, narrator reflects. Pull back to a wider shot or cut to an evocative object/environmental detail in the same scene.`;
  }

  const prevCtx = prevSeg
    ? `PREVIOUS BEAT (context only, do NOT render this): ${prevSpeaker ? `@${prevSpeaker}` : 'Narrator'} — "${String(prevSeg.narration || '').slice(0, 160)}"`
    : 'PREVIOUS BEAT: (none — this is the opening)';
  const nextCtx = nextSeg
    ? `NEXT BEAT (context only, do NOT render this): ${nextSpeaker ? `@${nextSpeaker}` : 'Narrator'} — "${String(nextSeg.narration || '').slice(0, 160)}"`
    : 'NEXT BEAT: (none — this is the closing)';

  return `You are writing a single image-generation prompt for one beat of a video episode. The prompt must make VISUAL SENSE given the adjacent beats — dialogue should read as a real conversation (shot-counter-shot, same location), narrator monologue should evolve composition rather than cut to random scenes.

SERIES STYLE (preserve this exactly): ${style}

ASPECT: ${aspect}

${prevCtx}

THIS BEAT (render this): ${thisSpeaker ? `@${thisSpeaker}` : 'Narrator'} — "${String(seg.narration || '').slice(0, 400)}"

${nextCtx}

LOCATION: ${locDescription}${locationMenuBlock}

CHARACTER IN FRAME: ${whoInFrame}

${continuityHint}

TASK: Write ONE image-generation prompt for THIS BEAT only. Format it as three sentences:
1. Composition — framing (wide / medium / close), subject position, what's in the foreground vs background. Respect any continuity hint above.
2. Light — lighting direction, key colours, mood of the light. Match the previous beat if we're in the same scene.
3. Mood — the emotional beat the image lands on.

Append at the end (exactly): "Ken Burns: ${motion}."

Constraints:
- Under 80 words total.
- Do NOT restate the narration as visible text — you're describing visuals only.
- Do NOT include any preamble, quotes, or explanation — return ONLY the prompt body.
- Stay in the series visual idiom.
- If this beat is a dialogue line, the character must be visible and identifiable (use the reference image).`;
}

function extractInlineTag(narration: string | undefined): string | null {
  const m = /^@([A-Z][A-Z0-9_-]{0,30})\s*:/.exec(String(narration || '').trim());
  return m ? m[1] : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- route ----------

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const projectId = String(body?.project_id || '').trim();
    if (!projectId) return Response.json({ error: 'project_id required' }, { status: 400 });
    const overwrite = Boolean(body?.overwrite);
    const styleOverride = typeof body?.style_anchor === 'string' ? String(body.style_anchor) : '';

    const [meta, script, timelineIn, promptsIn] = await Promise.all([
      getMeta(projectId),
      getScript(projectId),
      getTimeline(projectId),
      getPrompts(projectId),
    ]);
    if (!meta) return Response.json({ error: 'project not found' }, { status: 404 });
    if (!timelineIn || timelineIn.length === 0) {
      return Response.json({ error: 'timeline missing — run voiceover + transcribe first' }, { status: 400 });
    }

    const seriesId = meta.series_id || '';
    // Series-specific anchor if we've mapped one. Otherwise fall through to
    // a generic cinematic anchor — ad-hoc / chat-created / uploaded-audio
    // projects don't need a pipeline-registered series to autofill, they
    // just need ANY visual direction to hand Gemini.
    const GENERIC_ANCHOR =
      'Rendering: cinematic illustration with painterly lighting, subtle film grain, restrained palette that shifts per scene (warm tungsten for interiors, cool daylight for exteriors, neon only when the narration explicitly calls for it). Subjects are clearly drawn, never chibi or cartoon. Pick lighting + palette from the NARRATION, not a default. No photoreal, no 3D render, no Pixar style.';
    const style = styleOverride || SERIES_STYLE[seriesId] || GENERIC_ANCHOR;
    const aspect = meta.aspect || '16:9';

    // Speaker attribution — if segments are missing speakers, derive from script.
    let timeline = timelineIn.map((s) => ({ ...s }));
    let attributionChanged = false;
    if (script) {
      const turns = parseScriptTurns(script);
      const needsAttribution = timeline.some((s) => !s.speaker && !s.kind?.startsWith('end'));
      if (turns.length > 0 && needsAttribution) {
        const attributed = attributeSpeakers(timeline, turns);
        const before = JSON.stringify(timeline.map((s) => s.speaker || ''));
        const after = JSON.stringify(attributed.map((s) => s.speaker || ''));
        attributionChanged = before !== after;
        timeline = attributed;
      }
    }

    // Location catalog (project + subscribed library).
    const locations = await getMergedLocations(projectId);
    const locationCatalog = new Map<string, Location>();
    for (const l of locations) locationCatalog.set(l.id, l);
    const locationMenu = Array.from(locationCatalog.values());

    // Segments that need a prompt.
    const targets: { seg: Segment; idx: number }[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const existing = promptsIn?.[seg.id]?.prompt;
      if (existing && !overwrite) continue;
      if (!seg.narration || !seg.narration.trim()) continue;
      targets.push({ seg, idx: i });
    }

    let locStamped = 0;

    // ------ Pass 1: scene-level location picks ------
    if (locationMenu.length > 0) {
      const scenes = groupIntoScenes(timeline);
      for (const scene of scenes) {
        if (scene.segs.every((s) => s.location)) continue;
        const speakers = Array.from(new Set(scene.segs.map((s) => s.speaker || '').filter(Boolean)));
        const scenePrompt = buildScenePicker(style, scene, locationMenu, speakers);
        try {
          const out = await gemini(scenePrompt);
          const candidates = [...out.matchAll(/([a-z][a-z0-9_-]+)/gi)].map((m) => m[1].trim().toLowerCase());
          const pick = candidates.find((c) => locationCatalog.has(c));
          if (pick) {
            for (const s of scene.segs) {
              if (!s.location) { s.location = pick; locStamped++; }
            }
            attributionChanged = true;
          }
        } catch {
          // silent — per-segment pass will still try a menu pick
        }
        await sleep(80);
      }
    }

    // ------ Pass 2: per-segment prompts ------
    const next = { ...(promptsIn || {}) };
    let filled = 0;
    for (const { seg, idx } of targets) {
      const characterTag = seg.speaker || extractInlineTag(seg.narration) || null;
      const prevSeg = idx > 0 ? timeline[idx - 1] : null;
      const nextSeg = idx < timeline.length - 1 ? timeline[idx + 1] : null;
      const gp = buildGeminiPrompt({
        style, aspect, seg, segIdx: idx, totalSegs: timeline.length,
        locationCatalog, characterTag, prevSeg, nextSeg, locationMenu,
      });
      try {
        const out = await gemini(gp);
        let bodyText = out.trim();
        let pickedLoc: string | null = null;
        const locMatch = bodyText.match(/^(?:LOCATION[_\s-]?ID|Location)[\s:]+([A-Za-z0-9_-]+)\s*(?:\n|$)/i);
        if (locMatch) {
          const candidate = locMatch[1].trim();
          if (locationCatalog.has(candidate)) pickedLoc = candidate;
          bodyText = bodyText.slice(locMatch[0].length).trim();
        }
        // Defensive: strip any "LOCATION MENU: …" block (with or without
        // bullet list) if Gemini echoed the menu into the response. The
        // body should be just "Composition. Light. Mood. Ken Burns: …".
        // Look for a `---` separator that Gemini sometimes inserts between
        // the menu and the real prompt; if present, keep only what follows.
        const sepIdx = bodyText.indexOf('\n---\n');
        if (sepIdx >= 0) bodyText = bodyText.slice(sepIdx + 5).trim();
        bodyText = bodyText.replace(
          /^LOCATION\s+MENU[\s\S]*?(?=(?:^|\n)(?:[A-Z][a-z]|A |An |The )|$)/im,
          '',
        ).trim();
        const clean = bodyText.replace(/^["']+|["']+$/g, '').replace(/^\*+|\*+$/g, '').trim();
        next[seg.id] = {
          prompt: clean,
          narration: seg.narration,
          wardrobe: '',
          auto_filled: true,
          auto_filled_at: new Date().toISOString(),
        } as any;
        if (pickedLoc && !seg.location) {
          seg.location = pickedLoc;
          attributionChanged = true;
          locStamped++;
        }
        filled++;
      } catch {
        // skip; client can retry
      }
      await sleep(80);
    }

    await putPrompts(projectId, next);
    if (attributionChanged) {
      await putTimeline(projectId, timeline);
    }

    return Response.json({
      ok: true,
      filled,
      location_stamps: locStamped,
      total_segments: timeline.length,
      remaining_gaps: timeline.filter((s) =>
        s.narration && s.narration.trim() && !next[s.id]?.prompt
      ).length,
    });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
