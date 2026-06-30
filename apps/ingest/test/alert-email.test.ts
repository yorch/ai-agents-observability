import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type EmailConfig, sendEmail } from '../src/lib/notify/email.ts';
import { buildAlertPayload } from '../src/lib/notify/payload.ts';

// Capture the last sendMail call so assertions can inspect the rendered message.
const sentMail: Array<Record<string, unknown>> = [];
const createTransport = vi.fn(() => ({
  sendMail: vi.fn(async (msg: Record<string, unknown>) => {
    sentMail.push(msg);
    return { messageId: 'test' };
  }),
}));

vi.mock('nodemailer', () => ({
  createTransport: (opts: unknown) => createTransport(opts),
}));

const payload = buildAlertPayload(
  { name: 'Org spend spike', ruleType: 'spend_spike' },
  {
    details: { avgCost: 100, currentCost: 420, sigma: 3.2, stddev: 50, windowDays: 7 },
    firedAt: new Date('2026-06-24T12:00:00Z'),
    severity: 'critical',
  },
);

const config: EmailConfig = {
  from: 'alerts@obs.example',
  host: 'smtp.example',
  password: 'secret',
  port: 587,
  secure: false,
  user: 'mailer',
};

describe('sendEmail', () => {
  beforeEach(() => {
    sentMail.length = 0;
    createTransport.mockClear();
  });

  it('throws (no transport) when SMTP config is absent', async () => {
    await expect(sendEmail('ops@obs.example', payload)).rejects.toThrow(
      'SMTP transport not configured',
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('throws when the recipient is missing', async () => {
    await expect(sendEmail('', payload, config)).rejects.toThrow('missing recipient');
  });

  it('sends an aggregate-only message via the configured transport', async () => {
    await sendEmail('ops@obs.example', payload, config);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { pass: 'secret', user: 'mailer' },
        host: 'smtp.example',
        port: 587,
        secure: false,
      }),
    );
    expect(sentMail).toHaveLength(1);
    const msg = sentMail[0];
    expect(msg?.to).toBe('ops@obs.example');
    expect(msg?.from).toBe('alerts@obs.example');
    expect(String(msg?.subject)).toContain('Org spend spike');
    expect(String(msg?.text)).toContain(payload.description);
  });

  it('omits SMTP auth when no user is configured', async () => {
    await sendEmail('ops@obs.example', payload, {
      ...config,
      password: undefined,
      user: undefined,
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    );
  });

  it('never leaks individual-identifying data into the email body', async () => {
    const leaky = buildAlertPayload(
      { name: 'Org spend spike', ruleType: 'spend_spike' },
      {
        details: { currentCost: 420, login: 'octocat', sessionId: 'sess-1', userId: 'u-1' },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    await sendEmail('ops@obs.example', leaky, config);
    const serialized = JSON.stringify(sentMail[0]).toLowerCase();
    expect(serialized).not.toContain('octocat');
    expect(serialized).not.toContain('sess-1');
    expect(serialized).not.toContain('u-1');
  });
});
