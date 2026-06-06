import { startDeviceFlow } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export async function POST() {
  const { githubOAuthClientId } = getConfig();
  if (!githubOAuthClientId) {
    return NextResponse.json({ error: 'OAuth not configured' }, { status: 503 });
  }

  try {
    const result = await startDeviceFlow(githubOAuthClientId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Device flow start failed' }, { status: 502 });
  }
}
