# Local Agent Harness Design

## Goal

Make `wm-contact-sheet` useful when cloned into an agent workspace without requiring Casper's hosted backend, Supabase project, or provider keys.

## Access Model

- The public Vercel app remains a launcher/reference shell.
- Hosted `/api/*` routes stay private.
- Local users run their own harness and provide their own provider keys.
- Provider keys are stored only in local `.env.local`, which is ignored by git.

## First-Run Flow

`npm run harness` starts the local app and opens the browser. If required keys are missing, the app shows a setup dialog for:

- `FAL_KEY`
- `ELEVENLABS_API_KEY`
- `GEMINI_API_KEY`
- Optional tunnel URL

The setup endpoint is only active on localhost/development. It writes `.env.local` and updates the current Node process environment for the running dev session.

## Storage

Local harness mode defaults to filesystem storage under `.wm-data/`.

- JSON project documents live under `.wm-data/projects/<id>/`.
- Series and global preference docs live under `.wm-data/series/` and `.wm-data/global/`.
- Uploaded/generated assets live under `.wm-data/assets/`.
- Public asset URLs are served through a local API route so browser previews work.

Supabase remains supported only when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set.

## Agent Instructions

Add repo-local `AGENTS.md` with:

- How to install and start the harness.
- Which keys are required.
- Where local data lives.
- How to attach a tunnel.
- Rules forbidding committing `.env.local`, `.wm-data/`, or generated media unless intentionally sanitized.

## Validation

- `npm run build` must pass.
- `npm run harness` should start the app locally.
- Missing keys should show setup.
- Saving keys should create `.env.local`.
- Local project creation should write `.wm-data/` files without Supabase.
