import { isLocalStorageMode } from '@/app/lib/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REQUIRED = ['FAL_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY'] as const;

export async function GET() {
  const keys = Object.fromEntries(
    REQUIRED.map((name) => [name, Boolean(process.env[name]?.trim())]),
  );
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

  return Response.json({
    localStorage: isLocalStorageMode(),
    configured: missing.length === 0,
    keys,
    missing,
    tunnelUrl: process.env.WM_TUNNEL_URL || '',
  });
}
