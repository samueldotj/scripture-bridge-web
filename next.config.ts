import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `pg` opens raw sockets and loads optional native bindings. Bundling it into
  // the server build breaks that; keep it external.
  serverExternalPackages: ['pg'],

  // The console holds the service key and drives privileged operations. None of
  // it should ever be framed, cached by an intermediary, or leak a referrer to
  // a third party.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next's inline bootstrap and hydration payload require
              // 'unsafe-inline'. Dev additionally needs 'unsafe-eval': the HMR
              // runtime evaluates module code as strings, and without it React
              // never hydrates — the forms then fall back to native posts, and
              // a Server Action reached that way fails its origin check with a
              // 500 that looks like a bug in the action. Production builds do
              // no eval, so the relaxation stops at the dev server.
              process.env.NODE_ENV === 'development'
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
