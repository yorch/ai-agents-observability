-- Phase 4: Transcript full-text search index.
-- Populated by ingest on transcript upload; visibility-scoped at query time.

CREATE TABLE IF NOT EXISTS transcript_index (
  session_id      UUID NOT NULL,
  message_idx     INT NOT NULL,
  role            TEXT NOT NULL,
  ts              TIMESTAMPTZ,
  content_text    TEXT NOT NULL,
  content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED,
  PRIMARY KEY (session_id, message_idx),
  CONSTRAINT transcript_index_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS transcript_index_tsv_idx
  ON transcript_index USING GIN (content_tsv);

CREATE INDEX IF NOT EXISTS transcript_index_session_idx
  ON transcript_index (session_id);
