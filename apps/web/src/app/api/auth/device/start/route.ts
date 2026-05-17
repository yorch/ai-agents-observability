import { startDeviceFlow } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

export async function POST() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'OAuth not configured' }, { status: 503 });
  }

  try {
    const result = await startDeviceFlow(clientId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Device flow start failed' }, { status: 502 });
  }
}
