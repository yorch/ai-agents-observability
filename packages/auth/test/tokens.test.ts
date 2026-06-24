import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setKeysForTesting } from '../src/keys';
import {
  issueAccessToken,
  issueHookToken,
  issueRefreshToken,
  revokeToken,
  rotateRefreshToken,
  verifyAccessToken,
  verifyOpaqueToken,
} from '../src/tokens';

// ── Key setup ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const [privPem, pubPem] = await Promise.all([exportPKCS8(privateKey), exportSPKI(publicKey)]);
  process.env.JWT_ED25519_PRIVATE_KEY = privPem;
  process.env.JWT_ED25519_PUBLIC_KEY = pubPem;
  setKeysForTesting(privateKey, publicKey);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── DB mock helpers ───────────────────────────────────────────────────────────

type FakeToken = {
  expiresAt: Date | null;
  id: string;
  kind: 'ACCESS' | 'HOOK' | 'REFRESH';
  revokedAt: Date | null;
  tokenHash: string;
  userId: string;
};

function makeDb(store: Map<string, FakeToken> = new Map()) {
  const db = {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
    authToken: {
      create: vi.fn(async ({ data }: { data: Omit<FakeToken, 'id'> }) => {
        const record = { ...data, id: crypto.randomUUID() } as FakeToken;
        store.set(record.tokenHash, record);
        return record;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { tokenHash: string } }) => store.get(where.tokenHash) ?? null,
      ),
      update: vi.fn(
        async ({ data, where }: { data: Partial<FakeToken>; where: { id: string } }) => {
          for (const record of store.values()) {
            if (record.id === where.id) {
              Object.assign(record, data);
              return record;
            }
          }
          throw new Error('Record not found');
        },
      ),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Partial<FakeToken>;
          where: { id: string; revokedAt: null };
        }) => {
          let count = 0;
          for (const record of store.values()) {
            // where.revokedAt is null (only-unrevoked); treat missing as unrevoked.
            if (record.id === where.id && record.revokedAt == null) {
              Object.assign(record, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
  };
  return db;
}

// ── Access token ──────────────────────────────────────────────────────────────

describe('issueAccessToken / verifyAccessToken', () => {
  it('issues a JWT that round-trips through verify', async () => {
    const userId = crypto.randomUUID();
    const jwt = await issueAccessToken(userId);
    const payload = await verifyAccessToken(jwt);
    expect(payload.userId).toBe(userId);
    expect(payload.kind).toBe('ACCESS');
  });

  it('rejects a malformed JWT', async () => {
    await expect(verifyAccessToken('not.a.jwt')).rejects.toThrow();
  });

  it('rejects a JWT with a completely bogus signature', async () => {
    const userId = crypto.randomUUID();
    const jwt = await issueAccessToken(userId);
    const [header, payload] = jwt.split('.');
    // Replace the signature with all-A bytes (invalid EdDSA signature)
    const tampered = `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });
});

// ── Refresh token ─────────────────────────────────────────────────────────────

describe('issueRefreshToken / verifyOpaqueToken', () => {
  it('issues a cct_ prefixed token that verifies', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const token = await issueRefreshToken(db, userId);

    expect(token).toMatch(/^cct_[A-Z2-7]{32}$/);

    const payload = await verifyOpaqueToken(db, token);
    expect(payload.userId).toBe(userId);
    expect(payload.kind).toBe('REFRESH');
  });

  it('rejects a token not in the store', async () => {
    const db = makeDb();
    await expect(verifyOpaqueToken(db, 'cct_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1')).rejects.toThrow(
      'Token not found',
    );
  });

  it('rejects a token without the cct_ prefix', async () => {
    const db = makeDb();
    await expect(verifyOpaqueToken(db, 'invalid-token-format')).rejects.toThrow(
      'Invalid token format',
    );
  });
});

// ── Hook token ────────────────────────────────────────────────────────────────

describe('issueHookToken', () => {
  it('issues a hook-kind token that verifies', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const token = await issueHookToken(db, userId);
    const payload = await verifyOpaqueToken(db, token);
    expect(payload.kind).toBe('HOOK');
  });
});

// ── Rotation ──────────────────────────────────────────────────────────────────

describe('rotateRefreshToken', () => {
  it('rotates a valid refresh token into a fresh access + refresh pair', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const refresh = await issueRefreshToken(db, userId);

    const result = await rotateRefreshToken(db as never, refresh);

    expect(result.access).toBeTruthy();
    expect(result.refresh).toMatch(/^cct_[A-Z2-7]{32}$/);
    expect(result.refresh).not.toBe(refresh);
    // Original refresh token is now revoked (single-use).
    await expect(verifyOpaqueToken(db, refresh)).rejects.toThrow('Token has been revoked');
  });

  it('rejects double-rotation of the same token', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const refresh = await issueRefreshToken(db, userId);

    await rotateRefreshToken(db as never, refresh);
    await expect(rotateRefreshToken(db as never, refresh)).rejects.toThrow();
  });

  it('refuses to rotate a hook token (privilege-crossing guard)', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const hookToken = await issueHookToken(db, userId);

    await expect(rotateRefreshToken(db as never, hookToken)).rejects.toThrow(
      'Token is not a refresh token',
    );
  });
});

// ── Revocation ────────────────────────────────────────────────────────────────

describe('revokeToken', () => {
  it('rejects a revoked token', async () => {
    const db = makeDb();
    const userId = crypto.randomUUID();
    const token = await issueRefreshToken(db, userId);
    const { tokenId } = await verifyOpaqueToken(db, token);

    await revokeToken(db, tokenId);

    await expect(verifyOpaqueToken(db, token)).rejects.toThrow('Token has been revoked');
  });
});

// ── Expiry ────────────────────────────────────────────────────────────────────

describe('verifyOpaqueToken expiry', () => {
  it('rejects an expired token', async () => {
    const store = new Map<string, FakeToken>();
    const db = makeDb(store);
    const userId = crypto.randomUUID();
    const token = await issueRefreshToken(db, userId);

    // Backdate expiry to the past
    for (const record of store.values()) {
      record.expiresAt = new Date(Date.now() - 1000);
    }

    await expect(verifyOpaqueToken(db, token)).rejects.toThrow('Token has expired');
  });
});
