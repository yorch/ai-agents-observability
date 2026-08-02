# @ai-agents-observability/redaction

Pure-TS redaction pass for agent session transcripts (Claude Code, opencode, codex). Runs client-side in the hook before upload so raw secrets never touch the server, and again on ingest as a defence-in-depth second pass.

## Usage

```ts
import { redact } from '@ai-agents-observability/redaction';

const { text, flags } = redact(rawTranscript);
// text: redacted string (safe to upload)
// flags: list of rule names that triggered (stored in events.redaction_flags)
```

## Rules

Nine rule classes run **in the order below** — the order is load-bearing, not
alphabetical. Matches are replaced with `[REDACTED:<class>]`.

| # | Class | Pattern | Example match |
|---|---|---|---|
| 1 | `aws-access-key` | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| 2 | `aws-secret-key` | 40-char base64 + Shannon entropy ≥ 4.5 bits/char | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| 3 | `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` (36 chars) or `github_pat_` (82 chars) | `ghp_16C7e42F292c6912E169B7B89B29DCA4BCBA` |
| 4 | `jwt` | `eyJ…header.eyJ…payload.signature` | Full JWT token string |
| 5 | `slack-token` | `xox[abp]-<10+ chars>` | `xoxb-123456789012-…` |
| 6 | `env-secret` | `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `*_PASSWORD=` | `API_TOKEN=hunter2` → `API_TOKEN=[REDACTED:env-secret]` |
| 7 | `private-key` | `-----BEGIN … PRIVATE KEY-----` block | RSA, EC, OPENSSH, PGP key blocks |
| 8 | `git-remote-url` | URL userinfo — `scheme://user:secret@host` | `https://user:pw@gitlab.com/x` → `https://[REDACTED:git-remote-url]@gitlab.com/x` |
| 9 | `email` | Address with a required dotted TLD (PII) | `dev@example.com` |

**Why the order matters.** The structural token rules run first, so a *known*
token sitting in a URL's password position is redacted under its own class
before `git-remote-url` sees it; `git-remote-url` then skips the resulting
`[REDACTED:…]` marker rather than clobbering it. Only the userinfo is scrubbed —
scheme, host and path survive so the remote stays identifiable. `email` runs
last because a bare address never overlaps the others.

## Entropy heuristic

`aws-secret-key` uses a Shannon entropy gate (threshold: **4.5 bits/char**) on top of the 40-char base64 length match to reduce false positives on things like commit SHAs or base64-encoded public data.

Formula: `H = -Σ p_i · log₂(p_i)` over unique characters in the 40-char candidate. Real AWS secrets score ≥ 4.8 bits/char; typical base64-padded data scores lower.

## Performance

Target: redact a 1 MB transcript in **< 50 ms** on 2020-era hardware. Run the benchmark with:

```bash
bun --filter '@ai-agents-observability/redaction' bench
```

## Testing

```bash
bun --filter '@ai-agents-observability/redaction' test
```

Includes:
- Per-class positive cassettes (`test/cassettes/*.txt`)
- Negative examples (no false positives)
- Overlap / composition safety
- `fast-check` property test: random lowercase alphanumeric strings never trigger structural rules
