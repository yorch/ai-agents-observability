import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@ai-agents-observability/db';
import { jwtVerify, SignJWT } from 'jose';

import { getPrivateKey, getPublicKey } from './keys.js';

// A type satisfied by both PrismaClient and Prisma TransactionClient
type DbClient = Pick<PrismaClient, 'authToken'>;

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
const REFRESH_TOKEN_TTL_DAYS = 90;
const HOOK_TOKEN_TTL_DAYS = 365;
const TOKEN_PREFIX = 'cct_';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function bytesToBase32(bytes: Uint8Array): string {
  let result = '';
  let buffer = 0;
  let bitsLeft = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      result += BASE32_ALPHABET[(buffer >> bitsLeft) & 0x1f];
    }
  }
  if (bitsLeft > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f];
  }
  return result;
}

function generateOpaqueToken(): string {
  // 20 bytes → 32 base32 chars
  const bytes = randomBytes(20);
  return TOKEN_PREFIX + bytesToBase32(new Uint8Array(bytes));
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// ── Access tokens (JWT) ───────────────────────────────────────────────────────

export async function issueAccessToken(userId: string): Promise<string> {
  const privateKey = await getPrivateKey();
  const now = Date.now();
  return new SignJWT({ kind: 'access', sub: userId })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor((now + ACCESS_TOKEN_TTL_MS) / 1000))
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

export type AccessTokenPayload = {
  kind: string;
  userId: string;
};

export async function verifyAccessToken(jwt: string): Promise<AccessTokenPayload> {
  const publicKey = await getPublicKey();
  const { payload } = await jwtVerify(jwt, publicKey, { algorithms: ['EdDSA'] });

  if (payload.kind !== 'access') {
    throw new Error('Token is not an access token');
  }
  if (typeof payload.sub !== 'string') {
    throw new Error('Token missing sub claim');
  }

  return { kind: payload.kind as string, userId: payload.sub };
}

// ── Opaque tokens (refresh / hook) ────────────────────────────────────────────

async function issueOpaqueToken(
  db: DbClient,
  userId: string,
  kind: 'refresh' | 'hook',
): Promise<string> {
  const plaintext = generateOpaqueToken();
  const tokenHash = hashToken(plaintext);
  const ttlDays = kind === 'hook' ? HOOK_TOKEN_TTL_DAYS : REFRESH_TOKEN_TTL_DAYS;
  const expiresAt = addDays(new Date(), ttlDays);

  await db.authToken.create({
    data: { expiresAt, kind, tokenHash, userId },
  });

  return plaintext;
}

export async function issueRefreshToken(db: DbClient, userId: string): Promise<string> {
  return issueOpaqueToken(db, userId, 'refresh');
}

export async function issueHookToken(db: DbClient, userId: string): Promise<string> {
  return issueOpaqueToken(db, userId, 'hook');
}

export type OpaqueTokenPayload = {
  kind: 'hook' | 'refresh';
  tokenId: string;
  userId: string;
};

export async function verifyOpaqueToken(
  db: DbClient,
  plaintext: string,
): Promise<OpaqueTokenPayload> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) {
    throw new Error('Invalid token format');
  }

  const tokenHash = hashToken(plaintext);
  const record = await db.authToken.findFirst({ where: { tokenHash } });

  if (!record) {
    throw new Error('Token not found');
  }
  if (record.revokedAt) {
    throw new Error('Token has been revoked');
  }
  if (record.expiresAt && record.expiresAt < new Date()) {
    throw new Error('Token has expired');
  }
  if (record.kind !== 'refresh' && record.kind !== 'hook') {
    throw new Error('Token has wrong kind');
  }

  return { kind: record.kind, tokenId: record.id, userId: record.userId };
}

export async function revokeToken(db: DbClient, id: string): Promise<void> {
  await db.authToken.update({
    data: { revokedAt: new Date() },
    where: { id },
  });
}

export async function rotateRefreshToken(
  prisma: PrismaClient,
  refreshPlaintext: string,
): Promise<{ access: string; refresh: string }> {
  return prisma.$transaction(async (tx) => {
    const { tokenId, userId } = await verifyOpaqueToken(tx as DbClient, refreshPlaintext);

    const revokedAt = new Date();
    const { count } = await tx.authToken.updateMany({
      data: { revokedAt },
      where: { id: tokenId, revokedAt: null },
    });
    if (count === 0) {
      throw new Error('Refresh token already rotated');
    }

    const [newRefresh, access] = await Promise.all([
      issueOpaqueToken(tx as DbClient, userId, 'refresh'),
      issueAccessToken(userId),
    ]);

    return { access, refresh: newRefresh };
  });
}
