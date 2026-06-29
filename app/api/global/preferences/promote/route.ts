// POST /api/global/preferences/promote { project_id }
//
// Read a project's latest preferences.json, ask Gemini to split its rules
// into PORTABLE (craft lessons that generalize across any story) vs
// PROJECT-SPECIFIC (names / identities / plot beats unique to this project).
// Merge the portable set into global/creative_preferences.json, deduping
// against existing rules by normalized-text similarity and bumping
// confidence when multiple projects produce the same lesson.
//
// Called automatically by /api/projects/{id}/preferences/refresh after a
// fresh mining pass. Can also be called standalone to backfill.

import { readJson, writeJson } from '@/app/lib/blob';
import { geminiGenerate } from '@/app/lib/gemini';
import type { GlobalPrefsDoc, GlobalRule } from '../route';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STORE_PATH = 'global/creative_preferences.json';
const PROJECT_PREFS_PATH = (id: string) => `projects/${id}/preferences.json`;

type ProjectRule = {
  topic?: string;
  rule?: string;
  confidence?: number;
  evidence_count?: number;
  examples?: string[];
};

type ProjectPrefs = {
  summary?: string;
  rules?: ProjectRule[];
  updated_at?: string;
};

const SYSTEM_PROMPT = `You filter learned preference rules for cross-project reuse in a video generation pipeline.

Each input rule is either:
  (A) PORTABLE — a craft/style/aesthetic lesson that applies regardless of the specific story, character name, plot, or setting. Examples:
      - "Avoid smiles in loss/defeat beats; use stoic, downcast expressions instead."
      - "Render clothing color changes with careful palette continuity per character."
      - "Interior scenes at dusk prefer rim lighting at 45° to preserve face features."
  (B) PROJECT-SPECIFIC — mentions a named protagonist, a particular contract, a specific location that only exists in this project, plot events, named characters, or identifiers that would confuse another project. Examples:
      - "The protagonist wears a navy suit with a gold watch." (specific wardrobe identity)
      - "VO_042 is the crying scene." (specific segment)
      - "The signing scene uses a mahogany boardroom." (specific setting)

For each PORTABLE rule, you may rewrite the text to STRIP any lingering project-specific identity ("the protagonist", "Marcus", "the lawyer") and replace with generic terms ("the character", "a secondary character"). Preserve the imperative.

Return STRICT JSON:
{
  "portable": [
    {
      "topic": "...",
      "rule": "generic imperative sentence, no project identifiers",
      "confidence": 0.0-1.0,
      "portability_note": "one-line reason this generalizes"
    }
  ],
  "project_specific": [ /* rules you rejected, for audit — no need to rewrite */ ]
}

Return ONLY JSON. No markdown fences, no commentary.`;

function normalizeRuleText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlapScore(a: string, b: string): number {
  const ta = new Set(normalizeRuleText(a).split(/\s+/).filter(Boolean));
  const tb = new Set(normalizeRuleText(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / new Set([...ta, ...tb]).size;
}

export async function POST(req: Request) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return Response.json({ error: 'GEMINI_API_KEY missing' }, { status: 500 });
    }
    const body = await req.json().catch(() => null);
    const projectId = String(body?.project_id || '').trim();
    if (!projectId) return Response.json({ error: 'project_id required' }, { status: 400 });

    const prefs = await readJson<ProjectPrefs>(PROJECT_PREFS_PATH(projectId));
    if (!prefs || !Array.isArray(prefs.rules) || prefs.rules.length === 0) {
      return Response.json({ promoted: 0, reason: 'no project rules to promote' });
    }

    const input = prefs.rules
      .filter((r) => typeof r.rule === 'string' && r.rule.trim().length > 0)
      .map((r) => ({ topic: r.topic, rule: r.rule, confidence: r.confidence ?? 0.6 }));
    if (input.length === 0) return Response.json({ promoted: 0 });

    const userPrompt = [
      `SOURCE PROJECT: ${projectId}`,
      '',
      'INPUT RULES (JSON):',
      JSON.stringify(input, null, 2),
    ].join('\n');

    const raw = await geminiGenerate(userPrompt, {
      system: SYSTEM_PROMPT,
      json: true,
      temperature: 0.2,
      maxOutputTokens: 3000,
    });

    let parsed: { portable?: any[]; project_specific?: any[] } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const stripped = raw.replace(/^```json\s*|\s*```$/g, '').trim();
      parsed = JSON.parse(stripped);
    }
    const portable: Array<{
      topic?: string;
      rule: string;
      confidence?: number;
      portability_note?: string;
    }> = Array.isArray(parsed?.portable)
      ? parsed.portable.filter((p: any) => typeof p?.rule === 'string' && p.rule.trim().length > 0)
      : [];

    // Merge into global doc.
    const current = (await readJson<GlobalPrefsDoc>(STORE_PATH)) ?? {
      rules: [],
      updated_at: new Date(0).toISOString(),
    };
    const now = new Date().toISOString();
    const DUP_THRESHOLD = 0.55;

    let promoted = 0;
    let merged = 0;
    for (const p of portable) {
      const rulText = p.rule.trim();
      // Find an existing rule this one is semantically close to.
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < current.rules.length; i++) {
        const s = overlapScore(current.rules[i].rule, rulText);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestScore >= DUP_THRESHOLD) {
        // Merge: add/bump source, raise confidence toward max, keep earliest text.
        const existing = current.rules[bestIdx];
        const hasSrc = existing.sources.find((s) => s.project_id === projectId);
        if (!hasSrc) {
          existing.sources.push({ project_id: projectId, first_seen: now });
        }
        existing.confidence = Math.min(
          0.99,
          Math.max(existing.confidence, p.confidence ?? 0.7) +
            0.05 * existing.sources.length,
        );
        existing.promoted_at = now;
        merged++;
      } else {
        const fresh: GlobalRule = {
          topic: p.topic,
          rule: rulText,
          confidence: Math.min(0.95, p.confidence ?? 0.7),
          sources: [{ project_id: projectId, first_seen: now }],
          promoted_at: now,
          portability_note: p.portability_note,
        };
        current.rules.push(fresh);
        promoted++;
      }
    }
    current.updated_at = now;
    // Sort by confidence desc so generate can take a top-N slice cheaply.
    current.rules.sort((a, b) => b.confidence - a.confidence);

    await writeJson(STORE_PATH, current);

    return Response.json({
      promoted,
      merged,
      rejected: Array.isArray(parsed?.project_specific) ? parsed.project_specific.length : 0,
      total_global_rules: current.rules.length,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 400) }, { status: 500 });
  }
}
