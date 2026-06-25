/* P7-007 PROTOTYPE — apply manually before running embed-transcripts.ts.
   NOT in packages/db/sql/migrations/ — the auto-runner does not pick this up.
   Requires pgvector: use timescale/timescaledb-ha or install pgvector separately.
   The IVFFlat index should be built AFTER populating data (REINDEX or drop+recreate). */

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS transcript_embeddings (
  session_id   UUID         NOT NULL,
  chunk_index  INT          NOT NULL,
  content_text TEXT         NOT NULL,
  embedding    vector(1536) NOT NULL,
  model        TEXT         NOT NULL DEFAULT 'text-embedding-3-small',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chunk_index),
  CONSTRAINT transcript_embeddings_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS transcript_embeddings_ivfflat_idx
  ON transcript_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
