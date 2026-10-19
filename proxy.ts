import { NextResponse, type NextRequest } from "next/server";

// A fresh nonce per request lets script-src stay strict (no 'unsafe-inline')
// while still allowing the inline hydration scripts Next's App Router
// generates for every page. style-src needs 'unsafe-inline' because Base
// UI (admin dialogs/popovers) sets inline style="" attributes for
// positioning, which CSP has no per-element nonce mechanism for. img-src
// needs blob: for the admin Sensors screen's camera preview — the Protect
// snapshot is fetched with the admin token and rendered via
// URL.createObjectURL, since a plain <img src> can't carry an auth header.
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function proxy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // API responses carry state, PIN labels and settings; nothing in between should keep a copy.
  if (req.nextUrl.pathname.startsWith("/api/")) response.headers.set("cache-control", "no-store");
  // Deliberately no Strict-Transport-Security: deploy/Caddyfile's optional
  // TLS layer uses `tls internal` (self-signed, untrusted by client devices
  // unless someone manually installs that CA). HSTS makes cert errors on a
  // host unbypassable once a browser has seen it, so pairing it with a
  // self-signed cert risks permanently locking a device — including the
  // Guided-Access iPad, which has no UI to clear it — out of the panel.
  return response;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
