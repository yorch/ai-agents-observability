import { createTransport } from 'nodemailer';

import type { AlertPayload } from './payload';

// SMTP email channel (P9-002 follow-up). The transport config is injected from the
// Zod-validated loadConfig() (CLAUDE.md: only loadConfig touches process.env) and
// threaded down through the scheduler → evaluate-alerts → dispatchAlert, so this
// module never reads process.env itself. TRUST GUARDRAIL: the subject and body are
// built only from the aggregate-only AlertPayload — never a session id, user id,
// login, or transcript excerpt.
export type EmailConfig = {
  from: string;
  host: string;
  password?: string;
  port: number;
  // SMTPS (implicit TLS, typically port 465). When false, nodemailer still
  // upgrades via STARTTLS if the server advertises it (typically port 587).
  secure: boolean;
  user?: string;
};

function renderText(payload: AlertPayload): string {
  const flag = payload.severity === 'critical' ? '[CRITICAL]' : '[WARN]';
  return [
    `${flag} ${payload.ruleName}`,
    '',
    payload.description,
    '',
    `Fired at: ${payload.firedAt}`,
    `Open the org dashboard: ${payload.url}`,
  ].join('\n');
}

export async function sendEmail(
  to: string,
  payload: AlertPayload,
  config?: EmailConfig,
): Promise<void> {
  if (!to) {
    throw new Error('email channel: missing recipient (config.to)');
  }
  if (!config) {
    throw new Error(
      'email channel: SMTP transport not configured (set SMTP_HOST, SMTP_PORT, SMTP_FROM)',
    );
  }
  const transport = createTransport({
    ...(config.user ? { auth: { pass: config.password ?? '', user: config.user } } : {}),
    host: config.host,
    port: config.port,
    secure: config.secure,
  });
  await transport.sendMail({
    from: config.from,
    subject: `[${payload.severity}] ${payload.ruleName}`,
    text: renderText(payload),
    to,
  });
}
