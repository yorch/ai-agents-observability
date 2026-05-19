import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'claude-telemetry';
const ACCOUNT = 'hook-token';
const FALLBACK_DIR = join(homedir(), '.claude-telemetry');
const FALLBACK_PATH = join(FALLBACK_DIR, 'token');

async function tryKeytar(): Promise<typeof import('keytar') | null> {
  try {
    return await import('keytar');
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  const keytar = await tryKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE, ACCOUNT, token);
    return;
  }
  await mkdir(FALLBACK_DIR, { recursive: true });
  await writeFile(FALLBACK_PATH, token, { encoding: 'utf8', mode: 0o600 });
}

export async function loadToken(): Promise<string | null> {
  const keytar = await tryKeytar();
  if (keytar) {
    return keytar.getPassword(SERVICE, ACCOUNT);
  }
  try {
    return await readFile(FALLBACK_PATH, 'utf8');
  } catch {
    return null;
  }
}

export async function deleteToken(): Promise<void> {
  const keytar = await tryKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE, ACCOUNT);
    return;
  }
  try {
    await unlink(FALLBACK_PATH);
  } catch {
    // Already gone
  }
}
