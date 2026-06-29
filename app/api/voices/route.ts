// GET /api/voices        -> user's voices
// GET /api/voices?q=name  -> merges public library search results

export const runtime = 'nodejs';
export const maxDuration = 15;

const XI = 'https://api.elevenlabs.io';

type Voice = {
  voice_id: string;
  name: string;
  preview_url?: string;
  category?: string;
  public_owner_id?: string;
};

async function getMyVoices(key: string): Promise<Voice[]> {
  const r = await fetch(`${XI}/v1/voices`, {
    headers: { 'xi-api-key': key },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`voices.get_all ${r.status}`);
  const data = (await r.json()) as { voices: any[] };
  return (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    preview_url: v.preview_url,
    category: v.category,
  }));
}

async function searchShared(key: string, q: string): Promise<Voice[]> {
  const url = `${XI}/v1/shared-voices?search=${encodeURIComponent(q)}&page_size=12`;
  const r = await fetch(url, { headers: { 'xi-api-key': key }, cache: 'no-store' });
  if (!r.ok) return [];
  const data = (await r.json()) as { voices: any[] };
  return (data.voices || []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    preview_url: v.preview_url,
    category: 'public',
    public_owner_id: v.public_owner_id,
  }));
}

export async function GET(req: Request) {
  try {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return Response.json({ error: 'ELEVENLABS_API_KEY missing' }, { status: 500 });
    const q = new URL(req.url).searchParams.get('q')?.trim() || '';
    const mine = await getMyVoices(key);
    let shared: Voice[] = [];
    if (q) shared = await searchShared(key, q);
    // Dedupe by voice_id, prefer "mine"
    const seen = new Set(mine.map((v) => v.voice_id));
    const combined = [...mine, ...shared.filter((v) => !seen.has(v.voice_id))];
    return Response.json({ voices: combined });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Import a shared voice into the user's account
  try {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return Response.json({ error: 'ELEVENLABS_API_KEY missing' }, { status: 500 });
    const body = await req.json();
    const owner = String(body?.public_owner_id || '');
    const voice_id = String(body?.voice_id || '');
    const new_name = String(body?.new_name || '').trim();
    if (!owner || !voice_id || !new_name) {
      return Response.json({ error: 'public_owner_id, voice_id, new_name required' }, { status: 400 });
    }
    const r = await fetch(`${XI}/v1/voices/add/${owner}/${voice_id}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name }),
    });
    if (!r.ok) {
      const t = await r.text();
      return Response.json({ error: `add failed: ${r.status} ${t.slice(0, 200)}` }, { status: 500 });
    }
    const data = await r.json();
    return Response.json({ ok: true, voice_id: data?.voice_id || voice_id });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
