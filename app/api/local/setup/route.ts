import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = ['FAL_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY', 'WM_TUNNEL_URL'] as const;

function allowLocalSetup(req: Request) {
  if (process.env.NODE_ENV === 'production') return false;
  const host = req.headers.get('host') || '';
  return host.startsWith('localhost:') || host.startsWith('127.0.0.1:') || host.startsWith('[::1]:');
}

function quoteEnv(value: string) {
  return JSON.stringify(value);
}

export async function POST(req: Request) {
  if (!allowLocalSetup(req)) {
    return Response.json({ error: 'setup is only available on local development hosts' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const entries: Record<string, string> = {};
  for (const name of ALLOWED) {
    const value = typeof body?.[name] === 'string' ? body[name].trim() : '';
    if (value) entries[name] = value;
  }

  for (const required of ['FAL_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY']) {
    if (!entries[required]) {
      return Response.json({ error: `${required} required` }, { status: 400 });
    }
  }

  entries.WM_STORAGE = 'local';
  entries.WM_DATA_DIR = body?.WM_DATA_DIR?.trim?.() || '.wm-data';

  const envPath = path.join(process.cwd(), '.env.local');
  let existing = '';
  try {
    existing = await fs.readFile(envPath, 'utf8');
  } catch {
    existing = '';
  }

  const managedStart = '# wm-contact-sheet local harness managed block';
  const managedEnd = '# end wm-contact-sheet local harness managed block';
  const block = [
    managedStart,
    ...Object.entries(entries).map(([key, value]) => `${key}=${quoteEnv(value)}`),
    managedEnd,
    '',
  ].join('\n');

  const stripped = existing
    .replace(new RegExp(`${managedStart}[\\s\\S]*?${managedEnd}\\n?`, 'm'), '')
    .trimEnd();
  await fs.writeFile(envPath, `${stripped ? `${stripped}\n\n` : ''}${block}`, { mode: 0o600 });

  for (const [key, value] of Object.entries(entries)) {
    process.env[key] = value;
  }

  return Response.json({
    ok: true,
    configured: true,
    message: 'Saved .env.local for this local harness.',
  });
}
