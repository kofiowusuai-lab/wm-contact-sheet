// Submit a FAL image generation job.
// Returns {request_id, status_url, response_url} so the client can poll.

import { getMergedLocations, readJson } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 30;

// Flux Dev supports a fixed enum for image_size. Map our 4-aspect catalog
// onto the closest Flux option. '4:5' falls back to portrait_4_3 which is
// the nearest Flux preset (Flux has no native 4:5).
const FLUX_IMAGE_SIZE: Record<string, string> = {
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '1:1':  'square',
  '4:5':  'portrait_4_3',
};

// Natural-language aspect directive appended to the prompt for Grok Imagine
// fresh generates (Grok has no aspect param — we steer via the prompt).
// For mode === 'edit' we skip this so the edit preserves reference composition.
const ASPECT_DIRECTIVE: Record<string, string> = {
  '16:9':
    'Composed for a landscape 16:9 frame — output dimensions 1920×1080, wide horizontal layout. ' +
    'Every named subject (host, character, prop, stat card, chart, icon) must sit ENTIRELY INSIDE the 16:9 boundary with comfortable margin on top, bottom, left, and right. ' +
    'Do not crop any subject at any edge. Distribute horizontal space: primary subject centre-or-centre-left, supporting elements flanking, environmental fill left and right. ' +
    'Never use portrait-stacked composition cues.',
  '9:16':
    'Composed for a vertical 9:16 frame — output dimensions 1080×1920, tall portrait layout. ' +
    'Every named subject (host, character, prop, stat card, chart, icon) must sit ENTIRELY INSIDE the 9:16 boundary with comfortable margin on top, bottom, left, and right. ' +
    'Do not crop any subject at any edge. Distribute vertical space: primary subject upper-to-middle, supporting elements below, environmental fill top and bottom. ' +
    'Never use landscape composition cues — do not place subjects side-by-side horizontally across the whole frame; stack them vertically instead.',
  '1:1':
    'Composed for a square 1:1 frame — output dimensions 1080×1080. ' +
    'Every named subject must sit entirely inside the 1:1 boundary with balanced negative space on all four sides. Do not crop any subject at any edge.',
  '4:5':
    'Composed for a portrait 4:5 frame — output dimensions 1080×1350, slightly taller than wide. ' +
    'Every named subject must sit entirely inside the 4:5 boundary with comfortable margin on top, bottom, left, and right. Do not crop any subject at any edge. ' +
    'Stack subjects vertically where possible; avoid wide-landscape composition cues.',
};

const STYLE_ANCHOR =
  '2D cel-shaded anime style, clean black line art, flat colors with soft ' +
  'painterly shading, realistic almond eyes NOT chibi, adult slim proportions, ' +
  'cinematic composition, painterly illustrated background consistent with character style. ' +
  // Aspect-agnostic full-bleed rule — the per-aspect directive (ASPECT_DIRECTIVE)
  // owns layout steering (portrait stacking vs landscape flanking). Keep this
  // block neutral so 9:16 / 1:1 / 4:5 projects don't inherit landscape bias.
  'The scene must fill the output frame corner to corner with content appropriate to the ' +
  'requested aspect ratio — never letterboxed, never shrunk, never padded. Do NOT impose ' +
  'landscape composition on a portrait frame or portrait composition on a landscape frame; ' +
  'follow the aspect directive appended to the prompt. ' +
  // Reference-image usage: character refs are provided to lock identity,
  // not composition. The refs are subject-on-white studio portraits. The
  // model must use them to copy face/hair/wardrobe/skin tone only — never
  // inherit their white studio backdrop, their centered portrait pose, or
  // their empty negative space. Background must come from the prompt +
  // location reference (if supplied), not from the character portraits.
  'REFERENCE IMAGE USAGE (critical): the attached reference images serve TWO distinct roles. ' +
  'The first reference (if supplied) is the LOCATION PLATE — copy its architecture, furniture, ' +
  'window placement, color palette, and lighting. The remaining references are CHARACTER ' +
  'IDENTITY CARDS — copy ONLY the character face, hair, skin tone, wardrobe, and body type. ' +
  'Do NOT copy the character-reference backgrounds, do NOT copy their studio whiteout, do NOT ' +
  'copy their centered-portrait composition, do NOT shrink the character into a corner of a ' +
  'white void, and do NOT inherit the reference\'s aspect ratio — the output aspect is driven ' +
  'by the aspect directive, not by any reference image. The generated frame must inhabit the ' +
  'location plate, fully rendered edge to edge, with the character naturally placed inside ' +
  'that environment at the pose + angle the prompt describes. If no location plate is given, ' +
  'invent an environment consistent with the prompt — never default to a white studio backdrop ' +
  'or empty colored field. ' +
  // Ken Burns safety: outputs are animated with up to ~15% zoom-in + ~22% pan
  // travel, so the character must start well inside the safe zone on every
  // side or hair/head/props get sliced off when the motion runs.
  'CRITICAL FRAMING RULES (Ken Burns safe zone): DEFAULT TO WIDE ANGLE ESTABLISHING SHOTS. ' +
  'The Ken Burns post-process applies up to a 15% zoom-in and a 22% pan on every frame, so the ' +
  'starting composition MUST include extra environmental space on ALL FOUR SIDES that the ' +
  'motion will eat into. Leave at least 15% margin between the subject and every edge of the ' +
  'frame (top, bottom, left, right) — the full head (including hair/hat/accessories), ' +
  'shoulders, hands, torso, and any named props must sit ENTIRELY INSIDE that margin. ' +
  'Environment fills the outer 15% of the frame on all four sides so that a 15% zoom-in or a ' +
  '22% pan never crops the subject. NEVER render tight portraits, close-up faces, head-only ' +
  'crops, cropped shoulders, or compositions where anything touches a frame edge — the Ken ' +
  'Burns motion would slice through them. ALWAYS prefer wide and medium-wide establishing ' +
  'shots. Close-ups are only permitted when the narration explicitly names a detail (e.g. a ' +
  'ring, a ballot, a hand) AS THE SUBJECT — never for character-face shots. ' +
  // Anti-matte / anti-border: Flux + Grok occasionally interpret "painterly
  // illustration" as a storybook-page layout with a cream / white paper
  // matte around the art. Hard-forbid that explicitly — the illustration
  // MUST bleed to the physical edge of the frame on every side.
  'FULL-BLEED RENDER REQUIREMENT: the illustration must extend to the absolute physical edges ' +
  'of the frame on all four sides — no border, no matte, no page framing, no cream or white ' +
  'padding around the artwork, no paper background visible anywhere. Edge to edge, corner to ' +
  'corner. Do NOT render this as a framed book page, magazine spread, polaroid, or postcard. ' +
  'Every pixel of the output image must depict the scene environment or the character — ' +
  'absolutely no blank, flat, or solid-color regions at any edge of the frame.';

const NEG =
  'no photoreal, no 3D render, no hyperrealistic, no chibi, no big sparkly moe ' +
  'eyes, no duplicate main character, no gibberish text, no style mix, no cartoon ' +
  'Disney style, no Simpsons style, ' +
  // Anti-matte / anti-border — see STYLE_ANCHOR note above.
  'no page matte, no cream border, no white border, no paper frame, no page ' +
  'framing, no storybook page layout, no polaroid frame, no postcard border, ' +
  'no vignette fade, no gallery frame, no faux photo mount, ' +
  // Anti-white-studio: character refs are white-bg portraits; forbid the
  // model from copying that studio void into the scene frame.
  'no white studio backdrop, no seamless white background, no empty white void, ' +
  'no pure white environment, no isolated character on plain white, no studio ' +
  'portrait composition, no character floating in blank space, no flat solid ' +
  'color background, no gradient backdrop, no cyclorama, ' +
  // Anti-tight-framing — the Ken Burns motion budget (15% zoom + 22% pan)
  // means tight compositions get cropped. Forbid explicitly so the model
  // renders wide-default compositions instead.
  'no tight portrait, no close-up face, no head-only crop, no cropped shoulders, ' +
  'no cropped torso, no cropped hair, no cropped hat, no headshot, no zoomed-in ' +
  'composition, no tight framing, no face fills the frame, no subject touches the ' +
  'edge, no limbs cut by the frame, no claustrophobic composition';

export async function POST(req: Request) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) {
    return Response.json({ error: 'FAL_KEY not configured' }, { status: 500 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.prompt) {
    return Response.json({ error: 'prompt required' }, { status: 400 });
  }
  const prompt = String(body.prompt).trim();
  // New callers pass image_urls[]; legacy callers pass protagonist_url.
  // Normalize everything into a single array before branching.
  const image_urls: string[] = Array.isArray(body.image_urls)
    ? body.image_urls.filter((u: any) => typeof u === 'string' && u.length > 0)
    : body.protagonist_url
      ? [String(body.protagonist_url)]
      : [];

  // Product placement guidance — free-text per product. Weaving these into
  // the prompt gives the model explicit direction (what, where, how often)
  // so the product actually shows up and doesn't get mutated into a random
  // object by the model's imagination.
  const product_notes: string[] = Array.isArray(body.product_notes)
    ? body.product_notes
        .filter((n: any) => typeof n === 'string' && n.trim().length > 0)
        .map((n: string) => n.trim())
    : [];

  // Aspect stamped onto the segment at generate-time. Optional for edit mode
  // (edits preserve reference composition). For fresh generates, drives both
  // FAL's image_size (Flux path) and the prompt's aspect directive.
  const aspect = typeof body?.aspect === 'string' ? String(body.aspect) : undefined;

  // Location continuity: resolve the supplied location id against the
  // project's merged catalog (own + subscribed library). If found, we
  // prepend its master image to image_urls[] so Grok weights it first,
  // and inject its canonical prose description into the prompt body.
  const locationId = typeof body?.location === 'string' ? String(body.location).trim() : '';
  const projectId = typeof body?.project_id === 'string' ? String(body.project_id).trim() : '';

  // Taste profile: combine portable cross-project rules + this project's own
  // rules into a short list prepended to the prompt. We cap the count + size
  // so we don't eat the Grok / Flux prompt budget on low-signal rules.
  let tasteBlock = '';
  try {
    type Rule = { rule?: string; confidence?: number };
    type GlobalDoc = { rules?: Rule[] };
    type ProjectDoc = { rules?: Rule[] };
    const [globalDoc, projectDoc] = await Promise.all([
      readJson<GlobalDoc>('global/creative_preferences.json'),
      projectId ? readJson<ProjectDoc>(`projects/${projectId}/preferences.json`) : Promise.resolve(null),
    ]);
    const pickRules = (doc: { rules?: Rule[] } | null, max: number, minConf: number) =>
      (doc?.rules ?? [])
        .filter((r) => typeof r.rule === 'string' && r.rule.trim().length > 0 && (r.confidence ?? 0) >= minConf)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, max)
        .map((r) => `- ${r.rule!.trim()}`);
    const globalLines = pickRules(globalDoc, 6, 0.7);
    const projectLines = pickRules(projectDoc, 6, 0.6);
    const sections: string[] = [];
    if (globalLines.length) sections.push(`Global taste (portable across projects):\n${globalLines.join('\n')}`);
    if (projectLines.length) sections.push(`Project taste (specific to this story):\n${projectLines.join('\n')}`);
    if (sections.length) {
      tasteBlock = ` Apply these learned rules when they don't conflict with the explicit prompt: ${sections.join(' // ')}`;
    }
  } catch {
    /* non-fatal — taste injection is best-effort */
  }
  let locationBlock = '';
  if (locationId && projectId) {
    try {
      const merged = await getMergedLocations(projectId);
      const loc = merged.find((l) => l.id === locationId);
      if (loc) {
        // Prefer an aspect-matching variant of the master plate when one
        // exists — see app/lib/reframeImage.ts for how they're produced.
        // Silent fallback to the 16:9 original so missing variants never
        // break generation.
        const variantUrl = aspect && loc.variants?.[aspect];
        const urlToUse = variantUrl || loc.image_url;
        if (urlToUse) image_urls.unshift(urlToUse);
        if (loc.description) {
          locationBlock =
            `Scene location: ${loc.name}. Match the reference image's FURNITURE LAYOUT, ` +
            `window placement, color palette, and lighting angle — but NOT its camera framing. ` +
            `Re-frame the shot as a WIDE ANGLE with the character and any props fully inside a ` +
            `Ken Burns safe zone: 20% headroom above hair, 15% margin on every other edge, ` +
            `never crop the head / face / hands, prefer medium-wide over tight portrait. ` +
            `${loc.description}`;
        }
      }
    } catch {
      // Non-fatal — proceed without location injection.
    }
  }

  // Edit mode: the user is making a small tweak to an existing frame.
  // Skip STYLE_ANCHOR and productClause — the source image already carries
  // the style, and piling extra stylistic text in front of the edit
  // instruction makes Grok treat it as a full re-generation and ignore the
  // change. Frame the request as an explicit edit directive instead.
  const mode = body?.mode === 'edit' ? 'edit' : 'generate';
  let combined: string;
  if (mode === 'edit') {
    const locationEditClause = locationBlock
      ? ` Preserve location continuity: ${locationBlock}`
      : '';
    combined =
      `Edit the reference image: ${prompt}. ` +
      `Keep the character identity, pose, framing, lighting, and background ` +
      `from the reference intact. Change ONLY what the instruction specifies. ` +
      `Preserve the 2D cel-shaded anime style of the source.${locationEditClause}${tasteBlock}`;
  } else {
    const productClause = product_notes.length
      ? ` Product placements to include: ${product_notes.join(' | ')}.`
      : '';
    const aspectClause = aspect && ASPECT_DIRECTIVE[aspect]
      ? ` ${ASPECT_DIRECTIVE[aspect]}`
      : '';
    const locClause = locationBlock ? ` ${locationBlock}` : '';
    combined = `${prompt}.${productClause}${locClause}${aspectClause}${tasteBlock} ${STYLE_ANCHOR}`;
  }

  let model_id: string;
  let falBody: Record<string, any>;
  if (image_urls.length === 0) {
    // Pure text-to-image — Flux Dev fallback (Grok edit requires reference images)
    model_id = 'fal-ai/flux/dev';
    falBody = {
      prompt: combined,
      negative_prompt: NEG,
      image_size: (aspect && FLUX_IMAGE_SIZE[aspect]) || 'landscape_16_9',
      num_inference_steps: 32,
      guidance_scale: 3.8,
      num_images: 1,
    };
  } else {
    // Image-conditioned — xAI Grok Imagine edit (handles 1–3 reference images natively).
    // Schema: { prompt, image_urls[], num_images?, resolution?, output_format?, sync_mode? }
    // No aspect_ratio param — wide-frame composition is enforced via the prompt text
    // (STYLE_ANCHOR appends the cinematic-width directive).
    model_id = 'xai/grok-imagine-image/edit';
    falBody = {
      prompt: combined,
      image_urls: image_urls.slice(0, 3),
      num_images: 1,
      resolution: '2k',
      output_format: 'jpeg',
    };
  }

  const res = await fetch(`https://queue.fal.run/${model_id}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(falBody),
  });
  if (!res.ok) {
    const t = await res.text();
    return Response.json(
      { error: `FAL submit failed: ${res.status} ${t.slice(0, 200)}` },
      { status: 500 },
    );
  }
  const sub = await res.json() as {
    request_id: string;
    status_url: string;
    response_url: string;
  };
  return Response.json({
    request_id: sub.request_id,
    status_url: sub.status_url,
    response_url: sub.response_url,
    model_id,
  });
}
