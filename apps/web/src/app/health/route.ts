import { NextResponse } from 'next/server';

// Lightweight liveness probe for the container HEALTHCHECK. Public — the proxy
// matcher only gates /me/*, so this never requires a session.
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
