/**
 * Admin script — creates (or updates) a user with email/password credentials.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run scripts/create-password-user.ts \
 *     --email user@example.com \
 *     --name "Display Name" \
 *     --password "s3cr3t"
 *
 * If a user with the given email already exists their password is updated.
 * Exits non-zero on any error.
 */

import { hashPassword } from '@ai-agents-observability/auth';
import { createClient } from '@ai-agents-observability/db';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const email = flag('email');
const name = flag('name');
const password = flag('password');

if (!email || !password) {
  console.error('Usage: create-password-user.ts --email <email> --password <password> [--name <display name>]');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = createClient(databaseUrl);

try {
  const passwordHash = await hashPassword(password);
  const existing = await db.user.findFirst({ where: { email } });

  if (existing) {
    await db.user.update({
      data: { passwordHash, ...(name ? { displayName: name } : {}) },
      where: { id: existing.id },
    });
    console.log(`Updated password for existing user: ${email} (id: ${existing.id})`);
  } else {
    const user = await db.user.create({
      data: {
        displayName: name ?? email,
        email,
        passwordHash,
        visibilityPolicy: { create: {} },
      },
    });
    console.log(`Created new user: ${email} (id: ${user.id})`);
  }
} finally {
  await db.$disconnect();
}
