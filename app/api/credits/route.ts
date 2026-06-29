// GET /api/credits
//   Returns credit/usage summaries from both providers.
//
//   {
//     eleven: { tier, used, limit, resets_at, status } | null,
//     fal:    { balance_usd, currency } | { error: "admin key required" } | null,
//   }
//
// ElevenLabs: GET /v1/user/subscription with xi-api-key — always works.
// FAL: balance endpoints are admin-key-only (regular keys get 403). If
// FAL_ADMIN_KEY is set in env, we query /billing/user_profile; otherwise
// return a note so the UI can point at fal.ai/dashboard/keys.

export const runtime = 'nodejs';
export const maxDuration = 10;

type ElevenDoc = {
  tier?: string;
  character_count?: number;
  character_limit?: number;
  next_character_count_reset_unix?: number;
  status?: string;
};

async function fetchEleven(): Promise<any> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { error: 'ELEVENLABS_API_KEY missing' };
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      cache: 'no-store',
    });
    if (!r.ok) return { error: `elevenlabs ${r.status}` };
    const d = (await r.json()) as ElevenDoc;
    return {
      tier: d.tier,
      used: d.character_count,
      limit: d.character_limit,
      resets_at: d.next_character_count_reset_unix
        ? new Date(d.next_character_count_reset_unix * 1000).toISOString()
        : null,
      status: d.status,
    };
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 120) };
  }
}

async function fetchFal(): Promise<any> {
  const admin = process.env.FAL_ADMIN_KEY;
  if (!admin) {
    return {
      error: 'FAL admin key required',
      hint: 'Create one at https://fal.ai/dashboard/keys and set FAL_ADMIN_KEY in Vercel env.',
    };
  }
  // FAL's /users endpoint exposes account lock status with an admin key.
  // The raw dollar balance requires system-admin access we don't have, but
  // is_locked + lock_reason is what actually gates generation anyway.
  try {
    // Use the trailing-slash URL directly — the non-slash variant sends a 307
    // that downgrades https→http, which Node's undici either loops on or
    // rejects outright ("redirect count exceeded" on Vercel).
    const r = await fetch('https://rest.alpha.fal.ai/users/', {
      headers: { Authorization: `Key ${admin}` },
      redirect: 'manual',
      cache: 'no-store',
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { error: `FAL /users ${r.status}: ${body.slice(0, 100)}` };
    }
    const arr = await r.json();
    const me = Array.isArray(arr) ? arr[0] : arr;
    if (!me) return { error: 'empty FAL response' };
    return {
      email: me.email,
      nickname: me.nickname,
      is_locked: !!me.is_locked,
      lock_reason: me.lock_reason ?? null,
      account_type: me.account_type,
      created_at: me.created_at,
    };
  } catch (e: any) {
    // Surface the real cause (DNS, TLS, timeout) instead of Node's opaque
    // "fetch failed" wrapper — the `cause` holds the system error code.
    const cause = e?.cause ? String(e.cause.code || e.cause.message || e.cause) : '';
    const msg = String(e?.message || e);
    return { error: `${msg}${cause ? ` (${cause})` : ''}`.slice(0, 180) };
  }
}

export async function GET() {
  const [eleven, fal] = await Promise.all([fetchEleven(), fetchFal()]);
  return Response.json(
    { eleven, fal, fetched_at: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
