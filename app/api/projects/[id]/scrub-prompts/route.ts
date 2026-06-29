// POST /api/projects/{id}/scrub-prompts
//
// Walks prompts.json and strips pollution artifacts from each auto-filled
// prompt body — specifically the "LOCATION MENU:\n- …\n---\n" preamble that
// Gemini used to echo back when the autofill route told it to pick from a
// menu that didn't exist for this project. The frames themselves don't
// regenerate; the caller should click "Generate all missing" after this to
// produce fresh images from the cleaned prompts.

import { getPrompts, putPrompts } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const maxDuration = 10;

type Ctx = { params: Promise<{ id: string }> };

function scrub(prompt: string): string {
  let body = String(prompt || '').trim();
  // Markdown-fence unwrap
  body = body.replace(/^```(?:json|text)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // If Gemini included a "LOCATION MENU: …\n---\n" preamble, keep only what
  // comes AFTER the --- separator.
  const sepIdx = body.indexOf('\n---\n');
  if (sepIdx >= 0) body = body.slice(sepIdx + 5).trim();
  // Leading "LOCATION_ID: xyz" line.
  body = body.replace(/^(?:LOCATION[_\s-]?ID|Location)[\s:]+[A-Za-z0-9_-]+\s*\n+/i, '');
  // Bare leading "LOCATION MENU: …" block up to a blank line or a sentence.
  body = body.replace(
    /^LOCATION\s+MENU[\s\S]*?(?=(?:^|\n)(?:[A-Z][a-z]|A |An |The )|$)/im,
    '',
  ).trim();
  // Stray wrapping quotes / asterisks
  body = body.replace(/^["'*]+|["'*]+$/g, '').trim();
  return body;
}

export async function POST(_: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const prompts = await getPrompts(id);
    if (!prompts) return Response.json({ ok: true, scrubbed: 0 });
    let scrubbed = 0;
    const out: typeof prompts = {};
    for (const [segId, entry] of Object.entries(prompts)) {
      const before = entry?.prompt || '';
      const after = scrub(before);
      if (after !== before) scrubbed++;
      out[segId] = { ...entry, prompt: after };
    }
    await putPrompts(id, out);
    return Response.json({ ok: true, scrubbed, total: Object.keys(prompts).length });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}
