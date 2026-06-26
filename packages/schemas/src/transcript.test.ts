import { describe, expect, it } from 'vitest';

import { TranscriptChunkMetaSchema } from './transcript';

describe('TranscriptChunkMetaSchema', () => {
  const validMeta = {
    chunk_index: 2,
    session_id: '123e4567-e89b-12d3-a456-426614174000',
    sha256: 'abc123def456',
    total_chunks: 3,
  };

  it('requires integer chunk positions', () => {
    expect(TranscriptChunkMetaSchema.safeParse({ ...validMeta, chunk_index: 1.5 }).success).toBe(
      false,
    );
    expect(TranscriptChunkMetaSchema.safeParse({ ...validMeta, total_chunks: 3.5 }).success).toBe(
      false,
    );
  });

  it('requires UUID session ids', () => {
    expect(
      TranscriptChunkMetaSchema.safeParse({ ...validMeta, session_id: 'session-1' }).success,
    ).toBe(false);
  });
});
