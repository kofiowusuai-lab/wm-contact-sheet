// POST /api/ai/chat-intake
//
// Conversational intake for the "Generate with AI" flow. Instead of a rigid
// form, the orchestrator chats with Gemini; Gemini asks one follow-up at a
// time, keeps track of what it's learnt, and finalises with a manifest that
// drops straight into POST /api/ai/draft-episode.
//
// Request:
//   {
//     history: [{ role: 'user' | 'assistant', content: string }, …],
//     known_series?: [{ id, title }],
//   }
//
// Response:
//   {
//     message: string,               // next assistant utterance
//     ready: boolean,                // true when the manifest is complete
//     intake?: {                     // present only when ready === true
//       series_id?: string,          // pick an existing series from known_series
//       series_title?: string,       // only when creating a new series
//       title: string,
//       aspect: '16:9' | '9:16',
//       runtime: 'short' | 'long',
//       speaker_hint: number,        // 0..5
//       names?: string[],
//       theme: string,
//       style_anchor?: string,
//     },
//   }

export const runtime = 'nodejs';
export const maxDuration = 30;

const GEMINI_MODEL = 'gemini-2.5-flash';

type ChatMsg = { role: 'user' | 'assistant'; content: string };

async function gemini(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
  };
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status === 503 || r.status === 429) {
      lastErr = new Error(`${r.status} ${text.slice(0, 100)}`);
      await new Promise((res) => setTimeout(res, 1000 * attempt));
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

function buildSystemPrompt(history: ChatMsg[], known: Array<{ id: string; title: string }>): string {
  const knownBlock = known.length > 0
    ? `EXISTING SERIES the user might want to add an episode to:\n${known.map((s) => `  - id="${s.id}" title="${s.title}"`).join('\n')}\n\n`
    : 'EXISTING SERIES: none — the user will create a new series.\n\n';
  const convo = history.length === 0
    ? '(no messages yet — open the conversation)'
    : history.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  return `You are an intake assistant that helps Casper create a new YouTube episode. Casper will generate the script, voice, characters, and frames once intake is done, so your job is ONLY to collect enough information to feed the downstream orchestrator.

REQUIRED FIELDS (must all be set before you may finalize):
- series_id (pick an existing one if it fits) OR series_title (invent one if creating new)
- title (a specific episode title or theme, e.g. "Sleep debt basics" or "The day I walked out")
- runtime ('short' = ~45 seconds, 'long' = ~8:30 minutes)
- aspect ('16:9' landscape or '9:16' vertical)
- speaker_hint (0 for narration-only, or 1–5 for named speakers)
- theme (1–3 sentences describing what the episode is ABOUT)

OPTIONAL FIELDS:
- names (comma-separated names for the speakers, only if speaker_hint >= 1)
- style_anchor (free-text rendering + palette rules, only if the user wants override)

${knownBlock}
CONVERSATION SO FAR:
${convo}

YOUR TASK — decide your next message. Two possible shapes:

A) You still need more information. Return JSON of shape:
{
  "message": "ONE short friendly sentence — either a greeting for the first turn, or ONE specific follow-up question for a missing field. Don't dump a questionnaire. Don't ask multiple things. Propose sensible defaults when you can ('Landscape 16:9 or vertical 9:16? If unsure I'll assume 16:9.').",
  "ready": false
}

B) You have every REQUIRED field. Return JSON of shape:
{
  "message": "One-sentence confirmation that summarises the intake back to the user (e.g. 'Got it — a short 45s vertical episode under Dr Reid Shorts about sleep debt, narration only. Kicking off the draft now.').",
  "ready": true,
  "intake": {
    "series_id": "dr_reid_shorts",    // EXACTLY one of: a known id from the list above, OR omit + use series_title
    "series_title": "Dr Reid Shorts", // omit when series_id is set
    "title": "Sleep debt basics",
    "runtime": "short",
    "aspect": "9:16",
    "speaker_hint": 0,
    "names": [],
    "theme": "What happens to your brain after two missed nights of sleep",
    "style_anchor": ""                 // empty string when the user didn't override
  }
}

RULES:
- Ask ONE question per turn. Combining 'what series and what title' in one message is forbidden.
- If the user gives ambiguous input, propose an interpretation and ask them to confirm, don't re-question.
- Prefer series_id over series_title when the user's description matches an existing series loosely — confirm your guess in the message.
- When in doubt on runtime, default to 'short'. On aspect, default to '16:9' unless the user specifies vertical or mentions Shorts/TikTok/Reels.
- Never return the example manifest above verbatim — only use real values.
- Return ONLY JSON. No preamble, no markdown fences.`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const history: ChatMsg[] = Array.isArray(body?.history)
      ? body.history
          .filter((m: any) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
          .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
      : [];
    const knownSeries = Array.isArray(body?.known_series)
      ? body.known_series
          .map((s: any) => ({ id: String(s?.id || ''), title: String(s?.title || s?.id || '') }))
          .filter((s: any) => s.id.length > 0)
          .slice(0, 40)
      : [];

    const prompt = buildSystemPrompt(history, knownSeries);
    const raw = await gemini(prompt);
    let parsed: { message: string; ready: boolean; intake?: any };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(stripped);
    }

    const ready = Boolean(parsed?.ready);
    const message = String(parsed?.message || '').slice(0, 800);
    let intake: any = undefined;
    if (ready && parsed?.intake && typeof parsed.intake === 'object') {
      const i = parsed.intake;
      intake = {
        series_id: typeof i.series_id === 'string' && i.series_id.trim() ? i.series_id.trim() : undefined,
        series_title: typeof i.series_title === 'string' && i.series_title.trim() ? i.series_title.trim() : undefined,
        title: String(i.title || '').slice(0, 140).trim(),
        aspect: i.aspect === '9:16' ? '9:16' : '16:9',
        runtime: i.runtime === 'long' ? 'long' : 'short',
        speaker_hint: Math.max(0, Math.min(5, Number(i.speaker_hint) || 0)),
        names: Array.isArray(i.names)
          ? i.names.map((n: any) => String(n || '').trim()).filter((n: string) => n.length > 0).slice(0, 5)
          : [],
        theme: String(i.theme || '').slice(0, 1000).trim(),
        style_anchor: typeof i.style_anchor === 'string' ? i.style_anchor.slice(0, 800).trim() : '',
      };
      // Minimal validation — if Gemini declared ready=true without a title or theme,
      // demote to ready=false and re-ask.
      if (!intake.title || !intake.theme) {
        return Response.json({
          message: 'Almost there — one more detail: what\'s the specific episode title or theme? (e.g. "Sleep debt basics" or "The day I walked out")',
          ready: false,
        });
      }
      if (!intake.series_id && !intake.series_title) {
        return Response.json({
          message: 'Which series is this for? Pick an existing one or give me a name for a new series.',
          ready: false,
        });
      }
    }

    return Response.json({ message, ready, intake });
  } catch (e: any) {
    return Response.json(
      { error: String(e?.message || e).slice(0, 400) },
      { status: 500 },
    );
  }
}
