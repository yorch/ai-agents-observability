import { z } from 'zod';

export const TranscriptChunkMetaSchema = z.object({
  chunk_index: z.number().int().nonnegative(),
  session_id: z.uuid(),
  sha256: z.string(),
  total_chunks: z.number().int().positive(),
});

export type TranscriptChunkMeta = z.infer<typeof TranscriptChunkMetaSchema>;
