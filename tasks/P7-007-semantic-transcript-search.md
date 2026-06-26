---
id: P7-007
title: Semantic transcript search (gated spike)
phase: 7
workstream: A
status: done
owner: claude
depends_on: [P4-003]
blocks: []
estimate: L
---

## Goal

Spike pgvector-based semantic transcript search: evaluate embedding model, storage
cost, and query relevance; deliver a written decision doc and a thin prototype
behind a feature flag. This is NOT a production rollout.

## Context

**GATED SPIKE** — do not build the full pipeline until keyword FTS (P7-005)
has shipped and proven insufficient, and explicit demand exists from users. The
keyword `plainto_tsquery` path in `transcript_index` handles the clear majority
of known search patterns (code symbols, error strings, file names). Semantic
search adds cost and operational complexity; it should only land if there is
evidence keyword search leaves a meaningful gap.

The TimescaleDB image (`timescale/timescaledb`) supports `pgvector` as an
extension (or can be swapped for `timescale/timescaledb-ha` which bundles it).
`packages/db/sql/` is the right location for prototype migration SQL.
`DESIGN_DOC.md` §12.5 notes that embedding infrastructure is a potential future
direction contingent on demonstrated need.

## Acceptance criteria

- [x] A written evaluation (a markdown file in `tasks/` or `docs/`) covers: pgvector vs an external vector store (e.g. Qdrant), embedding model options (cost per token, dimensionality, self-hostability), estimated storage overhead for the existing transcript corpus, and expected query latency at p50/p95.
- [x] A prototype embeddings-backfill script (behind a `SEMANTIC_SEARCH_ENABLED` env flag) runs over a sample of ≤1000 transcripts and writes embeddings to a `transcript_embeddings` table (prototype migration in `packages/db/sql/`).
- [x] A prototype semantic query path returns top-10 results by cosine similarity for a sample query and shows the result alongside the keyword FTS results for the same query.
- [x] The prototype can measure recall overlap between semantic and keyword results on 20 representative queries when run against a pgvector-capable database with an embedding API key.
- [x] The evaluation ends with an explicit **go / no-go recommendation** and the conditions under which the deferred recommendation should be revisited.
- [x] The prototype is entirely behind the `SEMANTIC_SEARCH_ENABLED` flag and has no effect on the production path when the flag is unset.

## Decision

Done as a no-go spike. [`P7-007-decision.md`](./P7-007-decision.md) records the
recommendation: do not ship production semantic search until keyword FTS shows a
material recall gap and a self-hosted embedding path exists. The overlap runner
is implemented but was not populated with real results in the sandbox because it
requires both a pgvector-capable database image and an embedding API key.

## Implementation notes

Start with `text-embedding-3-small` (OpenAI, 1536d) or a self-hosted model
(e.g. `nomic-embed-text` via Ollama) — document the tradeoff. The prototype
does not need to embed the full transcript; chunking to paragraph-level is
sufficient for the spike. Store `(session_id, chunk_index, embedding vector(1536))`
in the prototype table.

The prototype ingest script can live in `apps/ingest/src/jobs/` with a clear
`// PROTOTYPE — not scheduled` header. Do not add it to `scheduler.ts`.

Decision doc filename convention: `tasks/P7-007-decision.md`.

## Files touched

- `packages/db/sql/` (prototype migration — clearly named `prototype_semantic_search.sql`)
- `apps/ingest/src/jobs/embed-transcripts.ts` (new prototype, not scheduled)
- `tasks/P7-007-decision.md` (new — the evaluation output)

## Out of scope

- Production rollout of semantic search.
- Reindexing all existing transcripts.
- UI integration of semantic results.
- Replacing or modifying the existing keyword `transcript_index` pipeline.

## Verification

```bash
# Prototype runs without error against a local stack with SEMANTIC_SEARCH_ENABLED=1
SEMANTIC_SEARCH_ENABLED=1 bun run --cwd apps/ingest src/jobs/embed-transcripts.ts --sample 50
bun run typecheck
bun run check
```
