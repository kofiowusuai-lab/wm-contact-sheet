// Basic Auth middleware for the hosted backend.
//
// The app shell is public so the Vercel link can be opened without a browser
// password prompt. Hosted API routes stay private because they expose project
// data, write Supabase objects, or spend provider keys. Public users should run
// their own local/Vercel copy with their own env vars or connect their own
// tunnel from the UI.

import { NextResponse, type NextRequest } from 'next/server';

const USERNAME = process.env.BASIC_AUTH_USERNAME || 'review';
const PASSWORD = process.env.BASIC_AUTH_PASSWORD || '';

export const config = {
  // Protect everything except Next.js internals and favicon
  matcher: ['/((?!_next|favicon.ico|robots.txt).*)'],
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  if (!PASSWORD && process.env.NODE_ENV !== 'production') {
    return NextResponse.next();
  }

  const auth = req.headers.get('authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    return unauthorized();
  }
  const decoded = atob(auth.slice('Basic '.length));
  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorized();
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== USERNAME || pass !== PASSWORD) {
    return unauthorized();
  }
  return NextResponse.next();
}

function unauthorized() {
  return new NextResponse('Authentication required', {
    status: 401,
  });
}
