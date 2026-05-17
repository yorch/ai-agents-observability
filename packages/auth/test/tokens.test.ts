import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setKeysForTesting } from '../src/keys.js';
import {
  issueAccessToken,
  issueHookToken,
  issueRefreshToken,
  revokeToken,
  verifyAccessToken,
  verifyOpaqueToken,
} from '../src/tokens.js';

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
  kind: 'access' | 'hook' | 'refresh';
  revokedAt: Date | null;
  tokenHash: string;
  userId: string;
};

function makeDb(store: Map<string, FakeToken> = new Map()) {
  return {
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
    },
  };
}

// ── Access token ──────────────────────────────────────────────────────────────

describe('issueAccessToken / verifyAccessToken', () => {
  it('issues a JWT that round-trips through verify', async () => {
    const userId = crypto.randomUUID();
    const jwt = await issueAccessToken(userId);
    const payload = await verifyAccessToken(jwt);
    expect(payload.userId).toBe(userId);
    expect(payload.kind).toBe('access');
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
    expect(payload.kind).toBe('refresh');
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
    expect(payload.kind).toBe('hook');
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
