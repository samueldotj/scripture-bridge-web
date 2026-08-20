import { NextResponse, type NextRequest } from 'next/server';

/**
 * A cheap redirect, not the authorisation check.
 *
 * Middleware runs on the Edge runtime, where the HMAC verification in
 * `lib/session` is unavailable, so this only asks whether a session cookie is
 * present. The real check — signature, expiry, and re-verification against
 * CONSOLE_OPERATORS — happens in the console layout and again inside every
 * Server Action, which is where a forged cookie would have to be caught.
 *
 * Placing it here as well means an unauthenticated visitor gets the sign-in
 * page instead of a flash of console chrome.
 */
export function middleware(request: NextRequest) {
  const hasCookie = request.cookies.has('sb_console_session');
  const { pathname } = request.nextUrl;

  if (!hasCookie && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (hasCookie && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
