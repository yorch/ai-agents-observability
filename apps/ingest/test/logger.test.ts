import { Hono } from 'hono';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { httpRequestsTotal } from '../src/lib/metrics';
import { loggerMiddleware } from '../src/middleware/logger';
import type { AppEnv } from '../src/types';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as Logger;

function appWithMetricsStatus(status: 200 | 500): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'request-id');
    return await loggerMiddleware(logger)(c, next);
  });
  app.get('/metrics', (c) => c.body(null, status));
  app.get('/health', (c) => c.body(null, 200));
  return app;
}

async function requestCount(): Promise<number> {
  const metric = await httpRequestsTotal.get();
  return metric.values.reduce((sum, value) => sum + value.value, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loggerMiddleware', () => {
  it('does not info-log a successful metrics scrape but still records it', async () => {
    const before = await requestCount();

    await appWithMetricsStatus(200).request('/metrics');

    expect(logger.info).not.toHaveBeenCalled();
    expect(await requestCount()).toBe(before + 1);
  });

  it('continues to info-log successful non-metrics requests', async () => {
    await appWithMetricsStatus(200).request('/health');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/health', status: 200 }),
      'res',
    );
  });

  it('info-logs a failed metrics scrape', async () => {
    await appWithMetricsStatus(500).request('/metrics');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/metrics', status: 500 }),
      'res',
    );
  });
});
