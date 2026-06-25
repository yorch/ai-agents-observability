---
id: P7-007-decision
title: Semantic Transcript Search — Spike Evaluation & Go/No-Go
date: 2026-06-25
status: no-go
---

# Semantic Transcript Search — Spike Evaluation

## Decision: NO-GO (for now)

Keyword full-text search (`tsvector`/GIN via `transcript_index`) is already shipped, zero-marginal-cost, and requires no external dependencies. No demonstrated recall gap justifies the added storage (~GBs), embedding API cost, operational complexity, and external egress of transcript content. **Revisit only if:** (a) overlap measurements confirm keyword FTS misses semantically-relevant sessions at a material rate, AND (b) a self-hosted embedding path is in place so transcripts never leave the deployment.

---

## 1. Scope of this spike

This is a measurement and evaluation spike, not a production rollout. All prototype code is gated behind `SEMANTIC_SEARCH_ENABLED=1` and has no effect on the production path when the flag is unset. The prototype:

- Chunks and embeds a sample of ≤1000 transcripts using `text-embedding-3-small` (OpenAI)
- Stores embeddings in a `transcript_embeddings` table (pgvector extension)
- Measures recall overlap between semantic top-10 and keyword top-10 on ≥20 representative queries
- Produces this written evaluation + go/no-go recommendation

---

## 2. pgvector vs External Vector Store (Qdrant)

### pgvector (in-DB)

**Pros:**
- Stays inside the existing TimescaleDB/Postgres — no new service to deploy, secure, or back up
- One consistent backup/restore story covering all data
- Transactional consistency with `sessions` table (CASCADE deletes, FK constraints)
- Free joins to relational data for hybrid queries (e.g. filter by team + semantic similarity)
- Fits the project's self-host-first, "keep stack state under `./data/`" design ethos

**Cons:**
- IVFFlat/HNSW index build/maintenance competes with OLTP load on the same Postgres instance
- Index tuning is manual (`lists`, `probes`, `ef_construction` parameters)
- Scaling vectors and time-series in one DB couples two very different workloads
- The standard `timescale/timescaledb` image does not include pgvector — requires switching to `timescale/timescaledb-ha` (or a custom image), which is a minor infrastructure change for existing deployments

### Qdrant (external)

**Pros:**
- Purpose-built approximate nearest-neighbour (ANN) engine with excellent recall/latency at scale
- Horizontal scaling, filtering on payload metadata, dedicated hardware tuning
- Mature client libraries, good observability tooling

**Cons:**
- A 5th service to run, secure, monitor, and back up
- Data duplication: embeddings live in Qdrant, metadata in Postgres — sync pipeline required
- No transactional join to Postgres: hybrid queries need application-level coordination
- Directly counter to this repo's "minimize services, self-host everything in one stack" design
- Only earns its keep past ~1–10M vectors with strict latency SLAs — this corpus is unlikely to reach that scale soon

### Verdict

**pgvector** is the right choice *if* semantic search is ever pursued — it avoids a new service and matches the self-host ethos. Qdrant adds significant operational overhead that is not justified until the corpus and query volume exceed what pgvector handles well. The breakeven is roughly 1–10M vectors with sub-10ms latency requirements.

---

## 3. Embedding Model: `text-embedding-3-small` vs `nomic-embed-text`

| Attribute | `text-embedding-3-small` (OpenAI) | `nomic-embed-text v1.5` (self-hosted) |
|---|---|---|
| Dimensionality | 1536 (MRL-truncatable to 512/256) | 768 |
| Cost | ~$0.020 / 1M tokens (API) | $0 marginal (self-hosted) |
| Self-hostable | No — requires egress to `api.openai.com` | Yes — Apache-2.0, runs on CPU or GPU via Ollama/llama.cpp |
| Context window | 8191 tokens | 8192 tokens |
| Quality | Strong MTEB baseline, widely validated | Competitive at its size; strong on long documents |
| Storage per embedding (float32) | 1536 × 4 B = **6,144 B** | 768 × 4 B = **3,072 B** |
| External dependency | Yes — OpenAI API key, billing, vendor lock | No |
| Privacy fit for this product | Poor — transcript text sent to OpenAI | Excellent — text stays in the deployment |

**Spike choice:** `text-embedding-3-small` — fastest path to measurement numbers; no infra setup needed for a one-time spike.

**Production recommendation (if semantic search ships):** `nomic-embed-text` self-hosted. This product ships a redaction pipeline precisely because transcripts contain sensitive content. Sending that content to OpenAI for embedding is architecturally inconsistent with the project's privacy posture. A self-hosted embedding service (e.g. Ollama running `nomic-embed-text`) deployed alongside the stack eliminates egress, halves storage, and removes per-token cost. The spike's use of OpenAI should be treated as temporary scaffolding only.

---

## 4. Storage Overhead Estimate

### Embedding storage (float32)

- `text-embedding-3-small`: 1536 dims × 4 B = **6,144 B ≈ 6 KB** per embedding
- `nomic-embed-text`: 768 dims × 4 B = **3,072 B ≈ 3 KB** per embedding

### Row overhead

Per `transcript_embeddings` row: ~40–60 B of Postgres row overhead + the `content_text` chunk (~4 KB per chunk, stored for query display).

### Projection: 10,000 sessions

Assuming avg 50 chunks per transcript and 10,000 sessions:

| Component | text-embedding-3-small | nomic-embed-text |
|---|---|---|
| Embeddings (500k × dims × 4 B) | ~3.0 GB | ~1.5 GB |
| `content_text` duplicated (500k × ~4 KB) | ~2.0 GB | ~2.0 GB |
| IVFFlat index (~0.5–1× vector data) | ~1.5–3.0 GB | ~0.75–1.5 GB |
| **Total estimate** | **~6–8 GB** | **~4–5 GB** |

For comparison: the existing `transcript_index` FTS adds only the `tsvector` column + GIN index — roughly **200–500 MB** for the same 10k-session corpus. **Semantic embeddings add 10–30× more storage than keyword FTS.**

The `content_text` duplication could be dropped in a production design (join to `transcript_index` instead) — saving ~2 GB. The spike keeps it for development convenience.

---

## 5. Query Latency Estimate

End-to-end semantic search latency has two components:
1. **Embedding the query** (vectorizing the user's search string): ~50–200 ms round-trip to OpenAI API (or ~5–30 ms self-hosted Ollama on a modern CPU). This is the dominant latency floor regardless of index size.
2. **ANN retrieval from pgvector** (cosine similarity scan):

| Vector count | Index type | DB query p50 | DB query p95 |
|---|---|---|---|
| ≤10k (spike corpus) | IVFFlat (exact scan likely) | ~2–5 ms | ~10 ms |
| 100k | IVFFlat (lists≈316, probes=10) | ~5–15 ms | ~30–50 ms |
| 1M | IVFFlat (tuned) | ~15–40 ms | ~80–150 ms |
| 1M | HNSW (ef_construction=200) | ~5–10 ms | ~20–40 ms |

**Note:** The spike's ≤1000-transcript corpus (≤50k chunks) is far too small to exercise ANN behavior — Postgres will likely do an exact scan, making IVFFlat irrelevant. Latency figures above 10k rows are projected from pgvector community benchmarks (Hugging Face, pgvector GitHub), not measured in this spike. Treat them as order-of-magnitude estimates.

**HNSW recommendation:** For production use, prefer HNSW over IVFFlat. HNSW doesn't require training data (IVFFlat needs rows before the index is meaningful), has better recall, and lower query latency at scale. Build cost is higher but irrelevant for a nightly batch workload.

---

## 6. Overlap Measurement Results

The embed-transcripts prototype script (`apps/ingest/src/jobs/embed-transcripts.ts`) measures Jaccard overlap between semantic and keyword FTS results on ≥20 representative queries. Results are written to `tasks/P7-007-overlap-results.json` after a real run.

**Results: PENDING REAL RUN**

This evaluation was completed in a sandbox environment where:
- No OpenAI API key was available to embed transcripts
- The pgvector extension required an image change (`timescaledb-ha`) not yet applied to the local stack

To populate this section:
1. Start the updated stack (`bun run docker:infra:up`)
2. Run: `SEMANTIC_SEARCH_ENABLED=1 OPENAI_API_KEY=sk-... bun run --cwd apps/ingest src/jobs/embed-transcripts.ts --sample 200 --measure`
3. Copy the summary statistics from `tasks/P7-007-overlap-results.json` into this section
4. Spot-check 3–5 queries where semantic and keyword results diverge — manually assess whether semantic-only results are genuinely relevant

**Interpretation guide:**
- **High mean Jaccard (>0.6):** semantic and keyword FTS largely agree → no compelling case for semantic search; reinforce no-go
- **Low mean Jaccard (<0.3) + high semantic-only relevant rate (manual spot-check):** genuine gap → grounds to revisit the go/no-go
- **Low Jaccard but semantic-only results are irrelevant:** semantic search has lower precision than keyword FTS → reinforce no-go
- **High semantic DB latency (p95 >100 ms):** even before API round-trip, DB cost is significant → operational concern

---

## 7. Prototype Architecture

### Infrastructure requirement

The prototype DDL (`CREATE EXTENSION vector`, the `transcript_embeddings` table, and the IVFFlat index) is in **`packages/db/sql/prototypes/prototype_semantic_search.sql`** — NOT in `packages/db/sql/migrations/`. The migrations runner does not scan subdirectories, so it will **not** auto-apply this file. Apply it manually against a pgvector-capable Postgres before running the embed script.

**Getting pgvector:**
- Use `timescale/timescaledb-ha:latest-pg18` (bundles pgvector) — note: the `-ha` image historically had uid issues with bind mounts, so prefer a fresh volume or verify your local setup
- Or install `postgresql-18-pgvector` in the container manually (e.g. `apt-get install postgresql-18-pgvector`)
- Or use any Postgres build with pgvector compiled in

`docker-compose.infra.yml` ships the standard `timescale/timescaledb:latest-pg18` image (no pgvector) to avoid breaking the baseline stack for developers not running this spike.

### Running the prototype

```bash
# 1. Apply the prototype schema manually (requires pgvector in your Postgres)
psql $DATABASE_URL -f packages/db/sql/prototypes/prototype_semantic_search.sql

# 2. Optionally rebuild the IVFFlat index AFTER populating data:
#    DROP INDEX transcript_embeddings_ivfflat_idx;
#    CREATE INDEX … (same DDL as in the file)

# 3. Run the backfill + measurement script
SEMANTIC_SEARCH_ENABLED=1 OPENAI_API_KEY=sk-... \
  bun run apps/ingest/src/jobs/embed-transcripts.ts --sample 200 --measure
```

### Flag behavior

All prototype code returns no-ops / exits when `SEMANTIC_SEARCH_ENABLED` is unset:
- `embed-transcripts.ts`: exits with code 1, emitting an explicit error message
- `searchTranscriptsSemantic()` (if implemented in `search-queries.ts`): returns `[]`
- The `transcript_embeddings` table exists in the DB but remains empty

An empty table with an IVFFlat index has no effect on query performance.

### Chunking strategy

Transcripts are chunked at paragraph level (split on `\n\n` boundaries) with:
- Target chunk size: ~4,000 characters (~1,000 tokens)
- Overlap: ~400 characters (~10%) to preserve context at boundaries
- Cap: 50 chunks per session (prevents pathological transcripts from dominating spend)
- Role-prefixed messages: `"user: ..."`, `"assistant: ..."` so role context is preserved in the embedding

### Cost estimate for the spike

A 200-transcript sample with avg 50 chunks = 10,000 chunks × ~1,000 tokens each = 10M tokens.
`text-embedding-3-small` at $0.020/1M tokens = **~$0.20** for a 200-transcript sample run.

---

## 8. Go/No-Go Recommendation

### Decision: NO-GO for production rollout

**Grounds:**
1. **Keyword FTS already ships** with zero marginal cost, no external dependencies, and sub-10ms query latency including ts_rank scoring
2. **No demonstrated gap:** we have no user feedback or query data showing keyword FTS fails to surface relevant sessions
3. **Privacy/egress concern:** embedding transcripts via OpenAI conflicts with the project's redaction-first, self-host posture. A self-hosted alternative (`nomic-embed-text`) requires standing up an additional GPU/CPU embedding service
4. **Storage cost is ~10–30× keyword FTS** for the same corpus
5. **Query latency is bounded by embedding round-trip (~50–200 ms to OpenAI)**, not by the ANN retrieval — a meaningful regression from keyword FTS's ~2–5 ms

### Conditions to revisit

Reopen this decision if ALL of the following hold:
1. The overlap study (once run on real data) shows keyword FTS misses a material set of genuinely relevant sessions (low Jaccard + manually-confirmed semantic-only recall)
2. A self-hosted embedding service (e.g. Ollama + `nomic-embed-text`) is deployed so transcripts never leave the deployment boundary
3. Explicit user demand for "find sessions about [concept]" beyond what symbol/keyword search supports

Until all three conditions hold, the spike code stays gated behind `SEMANTIC_SEARCH_ENABLED` and the `transcript_embeddings` table remains empty in production.
