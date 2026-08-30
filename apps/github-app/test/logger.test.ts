import { Hono } from 'hono';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggerMiddleware } from '../src/middleware/logger';
import type { AppEnv } from '../src/types';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
} as unknown as Logger;

function appWithMetricsStatus(status: 200 | 302 | 500): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'request-id');
    return await loggerMiddleware(logger)(c, next);
  });
  app.get('/metrics', (c) => c.body(null, status));
  app.post('/metrics', (c) => c.body(null, 200));
  app.get('/health', (c) => c.body(null, 200));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loggerMiddleware', () => {
  it('debug-logs a successful metrics scrape', async () => {
    await appWithMetricsStatus(200).request('/metrics');

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/metrics', status: 200 }),
      'res',
    );
  });

  it('continues to info-log successful non-metrics requests', async () => {
    await appWithMetricsStatus(200).request('/health');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/health', status: 200 }),
      'res',
    );
  });

  it('info-logs a successful non-GET metrics request', async () => {
    await appWithMetricsStatus(200).request('/metrics', { method: 'POST' });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/metrics', status: 200 }),
      'res',
    );
  });

  it('info-logs a redirected metrics request', async () => {
    await appWithMetricsStatus(302).request('/metrics');

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/metrics', status: 302 }),
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
