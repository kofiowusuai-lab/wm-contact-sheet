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

## Requirements and configuration reference

Use a current Node.js/npm runtime compatible with Next.js 14. No Node engine range is declared in `package.json`. `npm ci` installs the committed dependency lockfile. The local shell and project storage run without Supabase; generation, voice, QA, music, and remote finishing features require their own configured providers/services.

| Names | Used for |
|---|---|
| `WM_STORAGE`, `WM_DATA_DIR` | Storage mode (`local` or `supabase`) and local data location |
| `PORT`, `WM_NO_OPEN` | Harness preferred port; set `WM_NO_OPEN=1` to skip browser launch |
| `FAL_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY` | Required first-run setup fields for generation, voice, and QA |
| `WM_TUNNEL_URL` | Optional service URL saved by local setup |
| `OPENAI_API_KEY`, `FAL_ADMIN_KEY`, `JAMENDO_CLIENT_ID` | Feature-specific provider integrations |
| `ELEVENLABS_API_KEY_FALLBACK`, `ELEVENLABS_API_KEY_FALLBACK_2`, `ELEVENLABS_API_KEY_FALLBACK_3` | Optional additional voice provider keys |
| `SUPABASE_URL`, `SUPABASE_BUCKET`, `SUPABASE_SERVICE_ROLE_KEY` | Optional cloud storage configuration |
| `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD` | API authentication for production/private deployments |

Treat `.env.example` as a list of names and placeholders, not working credentials. Copying it verbatim also sets a placeholder Basic Auth password, which can cause local API requests to return 401. For the local harness, omit the Basic Auth variables unless you intentionally configure authentication. Supply only the provider variables needed by the features you use.

The setup endpoint accepts keys only on local development hosts, writes a managed block to `.env.local`, and sets local storage mode. It is disabled in production. The harness binds to `127.0.0.1` and searches up to 50 ports beginning at `PORT` or 3000.

## Workflow and source layout

1. Start your own local harness and complete local setup.
2. Create or select a project; import script/prompts and review segmented rows.
3. Add or generate frames, adjust aspect ratio/captions, and review QA results.
4. Configure authorized voices and audio/music as needed.
5. Preview the contact sheet and use available render/upload handoffs only after configuring the appropriate local/tunnel service.

The app includes controls for rendering, upload, analytics, and YouTube operations, but the repository's Next.js process alone is not a replacement for every external service used by these controls.

- [app/page.tsx](app/page.tsx): main workflow and state coordination.
- `app/components/`: contact sheet, frame/caption editors, voice/music controls, previews, and handoff dialogs.
- `app/lib/`: script/segment parsing, image transformations, caption styling/pagination, provider helpers, and storage.
- [app/lib/blob.ts](app/lib/blob.ts): local filesystem and cloud storage abstraction.
- `app/api/`: project/media/provider endpoints and local setup/upload/file routes.
- [middleware.ts](middleware.ts): API Basic Auth; non-API app shell remains public.
- [scripts/harness.mjs](scripts/harness.mjs): local dependency install, port selection, startup, and browser launch.

Local state is stored in `.wm-data/projects/<project_id>/`, `.wm-data/series/`, and `.wm-data/global/`. It includes project JSON and generated/uploaded media. Changing `WM_DATA_DIR` changes the storage root; back up your own data before moving it. Keep `.wm-data/` and private environment files out of version control.

## Verification and troubleshooting

```bash
npm ci
npm run build
npm start
```

`build` is the configured production compilation check. `start` serves that build and uses production API authentication rules; configure your own Basic Auth values before using protected APIs. There is no automated `test` or `lint` npm script. A build does not validate live provider generation, remote tunnel services, or uploads; test those manually with your own account and project.

If the browser does not open, use the localhost URL printed by the harness or set `WM_NO_OPEN=1`. For 401 responses, check authentication and whether you started a production build. For missing projects, verify storage mode and data directory. For setup 403 responses, use `localhost`/`127.0.0.1` in development. For stalled finishing or uploads, verify the tunnel service independently. Provider errors require checking keys, permissions, quotas, and supported inputs; repeated clicks may create billable work.

Deployment commands above are for an owner-controlled deployment with private configuration. Cloners should use their own hosting scope, backend, credentials, and data rather than the named maintainer deployment.

## Licensing

This repository does not include a top-level license file. Confirm reuse terms with the owner; dependencies and any bundled media retain their own licenses.
