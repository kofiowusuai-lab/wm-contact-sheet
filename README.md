# wm-contact-sheet

Local-first contact-sheet harness for agents assembling short-form video projects, reviewing segments, generating frames, managing voiceovers, and handing projects off to a video producer workflow.

Live app: https://wm-contact-sheet.vercel.app/

## Local Agent Harness

Use this path when cloning the repo into an agent workspace:

```bash
npm run harness
```

The harness script:

- installs dependencies if `node_modules/` is missing,
- starts Next.js on a free localhost port,
- opens the browser,
- uses filesystem storage under `.wm-data/`,
- shows a first-run setup dialog for FAL, ElevenLabs, Gemini, and an optional tunnel URL.

The setup dialog writes `.env.local` locally. It does not send provider keys to Casper's hosted backend.

## Public Access

The hosted app shell is public, but the hosted backend is private.

Public visitors can open https://wm-contact-sheet.vercel.app/ as an agent harness, but they do not get access to Casper's existing projects, generations, Supabase data, or provider keys. All hosted `/api/*` routes require Basic Auth using `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD`.

Users and agents should bring their own backend context:

- Clone and run the app locally with their own `.env.local` provider keys.
- Or attach their agent to a local/tunnel service and enter that tunnel URL in the app.
- Do not paste provider secrets into the public hosted app.

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

For local harness mode, `npm run harness` is preferred because it sets `WM_STORAGE=local`, picks a free port, opens the browser, and prompts for required keys.

For production-equivalent local testing, pull the Vercel environment instead of filling `.env.local` manually:

```bash
vercel link
vercel env pull .env.local
npm run dev
```

Do not commit `.env.local` or any provider keys.

For non-Casper users, create your own `.env.local` from `.env.example` instead of pulling Vercel env.

## Agent Harness Model

This app is intended to be attached to an agent, not used as a shared public SaaS backend.

The agent owns:

- Provider keys such as FAL, Gemini, OpenAI, ElevenLabs, Jamendo, and Supabase.
- Any local tunnel used for rendering, TTS, transcription, uploads, analytics, or long-running jobs.
- Its own project data and generated media.

The public Vercel link is a launcher/reference shell. Agent workflows should run against a local copy or the agent's own deployed backend.

Local project data lives in `.wm-data/` and is ignored by git.

## Deploy

```bash
npm run build
vercel --prod
```

The production Vercel project is `wm-contact-sheet` in the `kofi-sketchs-projects` scope.

## Agent Instructions

- Never commit real values for `BASIC_AUTH_PASSWORD`, Supabase service role keys, Vercel tokens, OpenAI keys, Gemini keys, FAL keys, ElevenLabs keys, Jamendo credentials, or generated `.env*` files.
- Keep the live link in this README when publishing to GitHub.
- Do not make hosted `/api/*` endpoints public without an explicit cost/security review.
- Do not add browser-side provider-key entry for the public hosted app; keys belong in the agent's local env or private backend.
- When changing auth behavior, verify both `https://wm-contact-sheet.vercel.app/` and unauthenticated hosted API access.
- For cloned-agent use, prefer `npm run harness`.
- Use `npm run build` before deployment.
