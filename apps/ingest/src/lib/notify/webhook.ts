import type { AlertPayload } from './payload';

// Generic webhook channel: POST the aggregate payload as JSON.
export async function sendWebhook(url: string, payload: AlertPayload): Promise<void> {
  if (!url) {
    throw new Error('webhook channel: missing url');
  }
  const res = await fetch(url, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`webhook POST failed: ${res.status}`);
  }
}
