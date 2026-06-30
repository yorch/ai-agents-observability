import { createTransport, type Transporter } from 'nodemailer';

import { type AlertPayload, severityLabel } from './payload';

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

// Cache one pooled transport per config. Alerts can fire several emails in a sweep,
// each with up to 3 retry attempts; without this every attempt would open a fresh
// TCP+TLS connection. Keyed by config so a (rare) config change rebuilds it.
let cached: { key: string; transport: Transporter } | null = null;

function transportFor(config: EmailConfig): Transporter {
  const key = JSON.stringify(config);
  if (cached?.key === key) {
    return cached.transport;
  }
  const transport = createTransport({
    ...(config.user ? { auth: { pass: config.password ?? '', user: config.user } } : {}),
    host: config.host,
    pool: true,
    port: config.port,
    secure: config.secure,
  });
  cached = { key, transport };
  return transport;
}

function renderText(payload: AlertPayload): string {
  return [
    `[${severityLabel(payload.severity)}] ${payload.ruleName}`,
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
  await transportFor(config).sendMail({
    from: config.from,
    subject: `[${severityLabel(payload.severity)}] ${payload.ruleName}`,
    text: renderText(payload),
    to,
  });
}
