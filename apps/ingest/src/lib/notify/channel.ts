import type { Logger } from 'pino';

import type { EmailConfig } from './email';
import { sendEmail } from './email';
import type { AlertPayload } from './payload';
import { sendSlack } from './slack';
import { sendWebhook } from './webhook';

export type ChannelConfigRow = {
  channelType: string;
  config: unknown;
  enabled: boolean;
};

// Minimal DB surface for delivery logging — keeps this layer testable with a mock.
type DeliveryLogDb = {
  alertDeliveryLog: {
    create(args: {
      data: { attemptedAt: Date; channelType: string; error: string | null; success: boolean };
    }): Promise<unknown>;
  };
};

const MAX_ATTEMPTS = 3;

function asObject(config: unknown): Record<string, unknown> {
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
}

async function deliverOnce(
  channelType: string,
  config: unknown,
  payload: AlertPayload,
  emailConfig?: EmailConfig,
) {
  const c = asObject(config);
  switch (channelType) {
    case 'webhook':
      return sendWebhook(String(c.url ?? ''), payload);
    case 'slack_webhook':
      return sendSlack(String(c.webhookUrl ?? c.url ?? ''), payload);
    case 'email':
      return sendEmail(String(c.to ?? ''), payload, emailConfig);
    default:
      throw new Error(`Unknown channel type: ${channelType}`);
  }
}

/**
 * Best-effort delivery of an alert to every enabled channel, with up to 3 attempts
 * per channel (exponential backoff) and a delivery-log row per channel. NEVER
 * throws — a bad webhook URL or SMTP error must not block the evaluation job
 * (P9-001). Persistent failures surface via alert_delivery_log in the admin UI.
 */
export async function dispatchAlert(
  db: DeliveryLogDb,
  channels: ChannelConfigRow[],
  payload: AlertPayload,
  logger?: Logger,
  emailConfig?: EmailConfig,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (const ch of channels) {
    if (!ch.enabled) {
      continue;
    }
    let lastError: string | null = null;
    let success = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await deliverOnce(ch.channelType, ch.config, payload, emailConfig);
        success = true;
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(2 ** attempt * 100);
        }
      }
    }
    if (!success) {
      logger?.warn({ channelType: ch.channelType, error: lastError }, 'alert delivery failed');
    }
    await db.alertDeliveryLog
      .create({
        data: {
          attemptedAt: new Date(),
          channelType: ch.channelType,
          error: lastError,
          success,
        },
      })
      .catch(() => {});
  }
}
