import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 65536;
const r = 8;
const p = 1;
const KEYLEN = 32;

function scryptHash(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; p: number; r: number },
): Promise<Buffer> {
  // scrypt needs ~128 * N * r bytes (≈64 MiB at N=65536, r=8), which exceeds
  // Node/Bun's default maxmem of 32 MiB and throws MEMORY_LIMIT_EXCEEDED.
  // Derive maxmem from the params (with headroom) so hash + verify agree.
  const maxmem = 128 * options.N * options.r * 2;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...options, maxmem }, (err, key) => {
      if (err) {
        reject(err);
      } else {
        resolve(key);
      }
    });
  });
}

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptHash(plaintext, salt, KEYLEN, { N, p, r });
  return `$scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  // format: $scrypt$params$salt$hash  → ['', 'scrypt', params, salt, hash]
  if (parts.length !== 5 || parts[1] !== 'scrypt') {
    return false;
  }
  const paramStr = parts[2];
  const saltB64 = parts[3];
  const keyB64 = parts[4];
  if (!paramStr || !saltB64 || !keyB64) {
    return false;
  }
  const paramMap: Record<string, string> = Object.fromEntries(
    paramStr.split(',').map((kv) => kv.split('=') as [string, string]),
  );
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptHash(plaintext, salt, expected.length, {
    N: Number(paramMap.N),
    p: Number(paramMap.p),
    r: Number(paramMap.r),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
