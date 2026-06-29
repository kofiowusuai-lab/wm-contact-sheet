# AGENTS.md

## Purpose

This repo is a local video contact-sheet harness for agents. Do not use Casper's hosted backend, Supabase bucket, provider keys, or generated projects. A cloned agent should run its own local harness and own its data.

## Start

```bash
npm run harness
```

The harness script installs dependencies if needed, starts Next.js on localhost, opens the browser, and uses local filesystem storage under `.wm-data/`.

On first run, the app asks for:

- `FAL_KEY`
- `ELEVENLABS_API_KEY`
- `GEMINI_API_KEY`
- optional tunnel URL

The setup dialog writes `.env.local`. Never commit `.env.local`.

## Data

Local project data lives in `.wm-data/`:

- `.wm-data/projects/<project_id>/`
- `.wm-data/series/`
- `.wm-data/global/`

Generated media and project JSON in `.wm-data/` are local runtime state. Do not commit them unless the user explicitly asks for a sanitized fixture.

## Tunnel

If rendering, upload, long-running TTS/transcription, analytics, or YouTube operations need a local service, enter that service URL in the tunnel field. Common local shape:

```text
http://127.0.0.1:8765
```

Cloudflared/ngrok URLs are also acceptable if the agent owns them.

## Safety

- Do not commit provider keys, Supabase service keys, Vercel tokens, `.env*`, or `.wm-data/`.
- Do not point public users at Casper's hosted `/api/*` backend.
- Keep provider keys in local env or in the agent-owned private backend.
- Run `npm run build` before publishing changes.
