import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/password';

describe('password hashing', () => {
  it('hashes a password into the scrypt format', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$scrypt\$N=\d+,r=\d+,p=\d+\$/);
  });

  it('verifies a correct password (roundtrip)', async () => {
    const hash = await hashPassword('s3cret-pass');
    await expect(verifyPassword('s3cret-pass', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('s3cret-pass');
    await expect(verifyPassword('wrong-pass', hash)).resolves.toBe(false);
  });

  it('produces a distinct hash each call (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same', a)).resolves.toBe(true);
    await expect(verifyPassword('same', b)).resolves.toBe(true);
  });
});
