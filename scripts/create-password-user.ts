/**
 * Admin script — creates (or updates) a user with email/password credentials.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun run scripts/create-password-user.ts \
 *     --email user@example.com \
 *     --name "Display Name" \
 *     --password "s3cr3t"
 *
 * Reads the password from stdin when --password is omitted (recommended for
 * production use — avoids the plaintext appearing in shell history / ps output).
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
let password = flag('password');

if (!email) {
  console.error(
    'Usage: create-password-user.ts --email <email> [--password <password>] [--name <display name>]',
  );
  process.exit(1);
}

if (!password) {
  process.stdout.write('Password: ');
  const n = Bun.spawnSync(['bash', '-c', 'read -rs PW && printf "%s" "$PW"'], { stdout: 'pipe' });
  password = n.stdout.toString();
  if (!password) {
    console.error('\nPassword is required');
    process.exit(1);
  }
  process.stdout.write('\n');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = createClient(databaseUrl);

try {
  const existing = await db.user.findUnique({ where: { email } });

  if (existing?.deactivatedAt) {
    console.error(
      `User ${email} is deactivated. Reactivate the account before setting a password.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const user = await db.user.upsert({
    create: {
      displayName: name ?? email,
      email,
      passwordHash,
      visibilityPolicy: { create: {} },
    },
    update: {
      ...(name ? { displayName: name } : {}),
      passwordHash,
    },
    where: { email },
  });

  const verb = existing ? 'Updated password for' : 'Created';
  console.log(`${verb} user: ${email} (id: ${user.id})`);
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await db.$disconnect();
}
