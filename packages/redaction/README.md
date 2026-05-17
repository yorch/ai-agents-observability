# @ai-agents-observability/redaction

Pure-TS redaction pass for Claude Code session transcripts. Runs client-side before upload so raw secrets never touch the server.

## Usage

```ts
import { redact } from '@ai-agents-observability/redaction';

const { text, flags } = redact(rawTranscript);
// text: redacted string (safe to upload)
// flags: list of rule names that triggered (stored in events.redaction_flags)
```

## Rules

Seven rule classes run in sequence. Matches are replaced with `[REDACTED:<class>]`.

| Class | Pattern | Example match |
|---|---|---|
| `aws-access-key` | `AKIA[0-9A-Z]{16}` | `AKIAIOSFODNN7EXAMPLE` |
| `aws-secret-key` | 40-char base64 + Shannon entropy ≥ 4.5 bits/char | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` (36 chars) or `github_pat_` (82 chars) | `ghp_16C7e42F292c6912E169B7B89B29DCA4BCBA` |
| `jwt` | `eyJ…header.eyJ…payload.signature` | Full JWT token string |
| `slack-token` | `xox[abp]-<10+ chars>` | `xoxb-123456789012-…` |
| `env-secret` | `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, `*_PASSWORD=` | `API_TOKEN=hunter2` → `API_TOKEN=[REDACTED:env-secret]` |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` block | RSA, EC, OPENSSH, PGP key blocks |

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
