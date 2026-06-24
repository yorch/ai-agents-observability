import type { AlertPayload } from './payload';

// Slack incoming-webhook channel. Posts a single aggregate text line — no
// individual-identifying data (the payload itself is aggregate-only).
export async function sendSlack(webhookUrl: string, payload: AlertPayload): Promise<void> {
  if (!webhookUrl) {
    throw new Error('slack channel: missing webhookUrl');
  }
  const emoji = payload.severity === 'critical' ? ':rotating_light:' : ':warning:';
  const text = `${emoji} *${payload.ruleName}* (${payload.severity})\n${payload.description}\n<${payload.url}|Open org dashboard>`;
  const res = await fetch(webhookUrl, {
    body: JSON.stringify({ text }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`slack POST failed: ${res.status}`);
  }
}
