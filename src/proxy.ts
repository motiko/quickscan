import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, createNonce } from '@/lib/csp';

/**
 * Per-request nonce Content-Security-Policy for documents. Next reads the nonce from the
 * request's CSP header and puts it on its inline and bootstrap scripts, so script-src needs
 * neither 'unsafe-inline' nor a host allowlist. The cost: pages render per request instead
 * of being prerendered (the root layout opts into dynamic rendering). See SECURITY.md.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const https =
    request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    upgradeInsecureRequests: https,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only: static files, the LLM proxy and public assets carry no inline scripts
      source:
        '/((?!api/|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|tesseract/|models/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
