import { startDeviceFlow } from '@ai-agents-observability/auth';
import { NextResponse } from 'next/server';

import { jsonError, withRouteLogging } from '@/lib/api-logging';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/request-context';

export const POST = withRouteLogging('auth.device.start', async () => {
  const { githubOAuthClientId } = getConfig();
  if (!githubOAuthClientId) {
    return jsonError('OAuth not configured', 503);
  }

  try {
    const result = await startDeviceFlow(githubOAuthClientId);
    return NextResponse.json(result);
  } catch (err) {
    logger.error({ err, reqId: getRequestId() }, 'auth.device.start_failed');
    return jsonError('Device flow start failed', 502);
  }
});
