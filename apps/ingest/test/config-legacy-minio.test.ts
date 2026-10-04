import { describe, expect, it } from 'vitest';

import { assertNoLegacyMinioEnv } from '../src/config';

describe('assertNoLegacyMinioEnv', () => {
  it('is silent when no legacy variables are set', () => {
    expect(() => assertNoLegacyMinioEnv({})).not.toThrow();
  });

  it('is silent when the S3_* pair is present, even alongside legacy names', () => {
    expect(() =>
      assertNoLegacyMinioEnv({
        MINIO_ROOT_PASSWORD: 'old',
        MINIO_ROOT_USER: 'old',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 'a-secret-of-16-chars',
      }),
    ).not.toThrow();
  });

  it('fails loudly with guidance when only the legacy names are set', () => {
    expect(() =>
      assertNoLegacyMinioEnv({ MINIO_ROOT_PASSWORD: 'x', MINIO_ROOT_USER: 'y' }),
    ).toThrow(/S3_ACCESS_KEY_ID \/ S3_SECRET_ACCESS_KEY.*migrate-from-minio/s);
  });

  it('names only what is missing', () => {
    expect(() => assertNoLegacyMinioEnv({ MINIO_ROOT_USER: 'y', S3_ACCESS_KEY_ID: 'k' })).toThrow(
      /but S3_SECRET_ACCESS_KEY is not/,
    );
  });
});
