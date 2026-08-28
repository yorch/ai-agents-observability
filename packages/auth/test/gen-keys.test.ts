import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { envFileFromArgs, generateKeypairPem, upsertEnv } from '../src/gen-keys';
import { getPrivateKey, getPublicKey, resetKeys } from '../src/keys';

describe('envFileFromArgs', () => {
  it('defaults to the local development env file', () => {
    expect(envFileFromArgs(['bun', 'gen-keys.ts'])).toBe('.env');
  });

  it('accepts a production env file', () => {
    expect(envFileFromArgs(['bun', 'gen-keys.ts', '--env-file=.env.production'])).toBe(
      '.env.production',
    );
  });
});

describe('generateKeypairPem', () => {
  it('emits PKCS8 private + SPKI public PEM', async () => {
    const { privatePem, publicPem } = generateKeypairPem();
    expect(privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(privatePem.trimEnd()).toMatch(/-----END PRIVATE KEY-----$/);
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(publicPem.trimEnd()).toMatch(/-----END PUBLIC KEY-----$/);
  });

  it('produces keys that import as EdDSA and sign/verify (the keys.ts contract)', async () => {
    const { privatePem, publicPem } = generateKeypairPem();
    const priv = await importPKCS8(privatePem, 'EdDSA');
    const pub = await importSPKI(publicPem, 'EdDSA');

    const jwt = await new SignJWT({ sub: 'u1' }).setProtectedHeader({ alg: 'EdDSA' }).sign(priv);
    // verifying with the public key proves it's the matching half of the pair
    const { payload } = await jwtVerify(jwt, pub);
    expect(payload.sub).toBe('u1');
  });

  it('generates a distinct keypair each call', () => {
    const a = generateKeypairPem();
    const b = generateKeypairPem();
    expect(a.privatePem).not.toBe(b.privatePem);
  });
});

const originalPrivateKey = process.env.JWT_ED25519_PRIVATE_KEY;
const originalPublicKey = process.env.JWT_ED25519_PUBLIC_KEY;

afterEach(() => {
  resetKeys();
  if (originalPrivateKey === undefined) {
    delete process.env.JWT_ED25519_PRIVATE_KEY;
  } else {
    process.env.JWT_ED25519_PRIVATE_KEY = originalPrivateKey;
  }
  if (originalPublicKey === undefined) {
    delete process.env.JWT_ED25519_PUBLIC_KEY;
  } else {
    process.env.JWT_ED25519_PUBLIC_KEY = originalPublicKey;
  }
});

describe('key environment loading', () => {
  async function expectEnvKeysToRoundTrip(): Promise<void> {
    const jwt = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .sign(await getPrivateKey());
    const { payload } = await jwtVerify(jwt, await getPublicKey());
    expect(payload.sub).toBe('u1');
  }

  it('imports keys whose PEM newlines are escaped', async () => {
    const { privatePem, publicPem } = generateKeypairPem();
    process.env.JWT_ED25519_PRIVATE_KEY = privatePem.trimEnd().replaceAll('\n', '\\n');
    process.env.JWT_ED25519_PUBLIC_KEY = publicPem.trimEnd().replaceAll('\n', '\\n');

    await expectEnvKeysToRoundTrip();
  });

  it('continues to import keys with real PEM newlines', async () => {
    const { privatePem, publicPem } = generateKeypairPem();
    process.env.JWT_ED25519_PRIVATE_KEY = privatePem;
    process.env.JWT_ED25519_PUBLIC_KEY = publicPem;

    await expectEnvKeysToRoundTrip();
  });
});

const KEYS = {
  privatePem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
  publicPem: '-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n',
};

function hasBothVars(content: string): boolean {
  return (
    /^JWT_ED25519_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\n/m.test(content) &&
    /^JWT_ED25519_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\\n/m.test(content)
  );
}

describe('upsertEnv', () => {
  it('appends both vars as unquoted single-line values with escaped newlines', () => {
    const out = upsertEnv('PORT=3000\n', KEYS, { force: false });
    expect(out).not.toBeNull();
    expect(hasBothVars(out as string)).toBe(true);
    expect(out).toContain('PORT=3000'); // preserves existing content
    expect(out).toContain(
      'JWT_ED25519_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----',
    );
  });

  it('normalizes a legacy CRLF multiline pair without rotating it', () => {
    const legacy = [
      'PORT=3000',
      'JWT_ED25519_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'AAAA',
      '-----END PRIVATE KEY-----"',
      'JWT_ED25519_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----',
      'BBBB',
      '-----END PUBLIC KEY-----"',
      '',
    ].join('\r\n');
    const out = upsertEnv(
      legacy,
      {
        privatePem: '-----BEGIN PRIVATE KEY-----\nCCCC\n-----END PRIVATE KEY-----\n',
        publicPem: '-----BEGIN PUBLIC KEY-----\nDDDD\n-----END PUBLIC KEY-----\n',
      },
      { force: false },
    );

    expect(out).toContain(
      'JWT_ED25519_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----',
    );
    expect(out).toContain(
      'JWT_ED25519_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\\nBBBB\\n-----END PUBLIC KEY-----',
    );
    expect(out).not.toContain('CCCC');
    expect(out).not.toContain('DDDD');
  });

  it('replaces a partial pair without leaving duplicate assignments', () => {
    const out = upsertEnv(
      'JWT_ED25519_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nOLD\\n-----END PRIVATE KEY-----\n',
      KEYS,
      { force: false },
    );

    expect(out?.match(/^JWT_ED25519_PRIVATE_KEY=/gm)).toHaveLength(1);
    expect(out?.match(/^JWT_ED25519_PUBLIC_KEY=/gm)).toHaveLength(1);
    expect(out).not.toContain('OLD');
    expect(hasBothVars(out as string)).toBe(true);
  });

  it('treats commented-out placeholders as absent and appends', () => {
    const out = upsertEnv('# JWT_ED25519_PRIVATE_KEY=\n# JWT_ED25519_PUBLIC_KEY=\n', KEYS, {
      force: false,
    });
    expect(out).not.toBeNull();
    expect(hasBothVars(out as string)).toBe(true);
  });

  it('returns null when keys already set and not forced', () => {
    const existing = upsertEnv('', KEYS, { force: false }) as string;
    expect(upsertEnv(existing, KEYS, { force: false })).toBeNull();
  });

  it('replaces the existing block (no duplicates) when forced', () => {
    const first = upsertEnv('', KEYS, { force: false }) as string;
    const next = {
      privatePem: '-----BEGIN PRIVATE KEY-----\nCCCC\n-----END PRIVATE KEY-----\n',
      publicPem: '-----BEGIN PUBLIC KEY-----\nDDDD\n-----END PUBLIC KEY-----\n',
    };
    const forced = upsertEnv(first, next, { force: true }) as string;
    expect(forced).not.toBeNull();
    // exactly one definition of each var remains
    expect(forced.match(/^JWT_ED25519_PRIVATE_KEY=/gm)).toHaveLength(1);
    expect(forced.match(/^JWT_ED25519_PUBLIC_KEY=/gm)).toHaveLength(1);
    expect(forced).toContain('CCCC');
    expect(forced).not.toContain('AAAA');
  });
});
