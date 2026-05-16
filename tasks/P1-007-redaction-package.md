---
id: P1-007
title: Redaction package v1 + test cassettes
phase: 1
workstream: B
status: ready
owner: null
depends_on: [P1-001]
blocks: [P1-012, P1-022]
estimate: M
---

## Goal

`packages/redaction` ships a pure-TS function `redact(text: string): { text: string, flags: string[] }` that strips the seven secret classes in `DESIGN_DOC.md` §9.1. Used both by the hook (pre-upload) and by ingest (defense-in-depth re-scan).

## Context

- §9.1 enumerates the classes: AWS keys, GCP keys, GitHub tokens, generic JWTs, private SSH/PGP key blocks, .env-style assignments to known-secret variable names, high-entropy strings flagged by length+charset heuristics.
- Pure TS (no native deps) so the same code runs in Bun, Node, and the compiled hook binary.
- Performance target: redact a 1 MB transcript in <50ms on a 2020-era laptop.

## Acceptance criteria

- [ ] One regex/heuristic per class, each in its own file under `packages/redaction/src/rules/`.
- [ ] `redact(text)` runs all rules in sequence; replacement is `[REDACTED:<class>]`.
- [ ] Returns `flags: string[]` listing which classes triggered (for `events.redaction_flags`).
- [ ] Test cassettes in `packages/redaction/test/cassettes/`: at least 3 positive + 1 negative per class. Cassettes are real-looking but synthetic.
- [ ] Test verifies no overlap-induced corruption (e.g., a GH token inside a JWT inside an .env line still redacts cleanly).
- [ ] Property test (`fast-check`): random alphanumeric input never matches as a false positive (modulo seeded controls).
- [ ] Benchmark in `packages/redaction/bench/redact.bench.ts` proves <50ms for 1MB input on CI hardware.
- [ ] README lists the rules and the entropy heuristic's thresholds.

## Implementation notes

- For the entropy heuristic: Shannon entropy over a sliding window of length ≥ 32 with charset ≥ base64; threshold ~4.5 bits/char. Tune against cassettes.
- Don't try to redact "data that looks sensitive" beyond the seven classes — false positives are worse than misses at v1, since the doc gates trust on user-visible behavior.
- Make sure the function is deterministic (same input ⇒ same output bytes) — important for retry idempotency.

## Files touched

- `packages/redaction/src/index.ts`
- `packages/redaction/src/rules/*.ts`
- `packages/redaction/test/redact.test.ts`
- `packages/redaction/test/cassettes/*`
- `packages/redaction/bench/redact.bench.ts`
- `packages/redaction/README.md`

## Out of scope

- ML-based PII detection.
- Per-org configurable rules (Phase 3+).
- Redacting non-text formats (images, binaries).

## Verification

```bash
pnpm --filter=@pkg/redaction test
pnpm --filter=@pkg/redaction bench
```
