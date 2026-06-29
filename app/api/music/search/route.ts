// GET /api/music/search?q=&mood=&genre=&duration_min=&duration_max=&limit=&offset=
//   Searches Jamendo's /tracks endpoint for royalty-free music. Jamendo's
//   catalog is ~600k+ CC-licensed tracks — their free tier is fine for
//   interactive search (100 req/min, 50k req/month).
//
// We proxy the call server-side so the JAMENDO_CLIENT_ID stays out of the
// browser, and so we can do lightweight shaping of the response into the
// shape the MusicLibraryModal expects.
//
// The user needs to set `JAMENDO_CLIENT_ID` in Vercel env vars — grab one
// from https://developer.jamendo.com/v3.0 (free, ~30 seconds). Without it
// we return a 503 with a clear error so the UI can tell the user what to do.

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

const JAMENDO = 'https://api.jamendo.com/v3.0';

export async function GET(req: Request) {
  try {
    const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
    if (!CLIENT_ID) {
      return Response.json(
        {
          error:
            'JAMENDO_CLIENT_ID not configured — sign up at developer.jamendo.com/v3.0 (free), create an app, then set JAMENDO_CLIENT_ID in Vercel env vars.',
          tracks: [],
        },
        { status: 503 },
      );
    }
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const mood = (url.searchParams.get('mood') || '').trim();
    const genre = (url.searchParams.get('genre') || '').trim();
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const durationMin = Math.max(0, Number(url.searchParams.get('duration_min')) || 0);
    const durationMax = Math.max(0, Number(url.searchParams.get('duration_max')) || 0);

    // Jamendo tags[] accepts AND-joined filters — mood + genre + anything
    // from a free-text `namesearch` together narrow the catalog surprisingly
    // fast. fuzzytags avoids near-misses when the user types "lofi" vs "lo-fi".
    const tagList: string[] = [];
    if (mood) tagList.push(mood);
    if (genre) tagList.push(genre);

    const params = new URLSearchParams();
    params.set('client_id', CLIENT_ID);
    params.set('format', 'json');
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('include', 'musicinfo');
    params.set('audioformat', 'mp32');
    params.set('imagesize', '300');
    params.set('order', q ? 'popularity_total' : 'popularity_week');
    if (q) params.set('namesearch', q);
    if (tagList.length) params.set('fuzzytags', tagList.join(' '));
    if (durationMin > 0) params.set('durationbetween', `${durationMin}_${durationMax || 9999}`);

    const jamUrl = `${JAMENDO}/tracks/?${params.toString()}`;
    const r = await fetch(jamUrl, { cache: 'no-store' });
    if (!r.ok) {
      return Response.json(
        { error: `jamendo ${r.status}: ${(await r.text()).slice(0, 200)}` },
        { status: 502 },
      );
    }
    const data: any = await r.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const tracks = results.map((t: any) => ({
      track_id: String(t.id),
      title: String(t.name || ''),
      artist: String(t.artist_name || ''),
      audio_url: String(t.audio || ''),
      duration: Number(t.duration || 0),
      image: String(t.image || ''),
      license: String(t.license_ccurl || ''),
      tags: {
        genres: Array.isArray(t.musicinfo?.tags?.genres) ? t.musicinfo.tags.genres : [],
        vartags: Array.isArray(t.musicinfo?.tags?.vartags) ? t.musicinfo.tags.vartags : [],
        instruments: Array.isArray(t.musicinfo?.tags?.instruments) ? t.musicinfo.tags.instruments : [],
      },
      releasedate: String(t.releasedate || ''),
      album: String(t.album_name || ''),
    }));

    return Response.json({
      total: Number(data?.headers?.results_count || tracks.length),
      count: Number(data?.headers?.results_fullcount || tracks.length),
      tracks,
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
