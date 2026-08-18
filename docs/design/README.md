# Design

## `ui-ux-review-2026-08.md` — post-revamp UI/UX review

A full review of `apps/web` conducted after the Instrument revamp landed ([#112](https://github.com/yorch/ai-agents-observability/pull/112)): verified bugs, a gap analysis (G1–G10) against dashboard-UX and WCAG 2.2 practice with `file:line` evidence, a prioritized roadmap, and sources. Its status note records which findings are implemented and which remain open (saved views, the first-run "waiting for first event" loop, table sorting, org-page streaming). The conventions that came out of it live in [`apps/web/AGENTS.md`](../../apps/web/AGENTS.md).

## `ui-direction.html` — "Instrument"

The design direction behind the `apps/web` UI revamp ([#101](https://github.com/yorch/ai-agents-observability/pull/101)). Open it in a browser; it is self-contained and needs no network.

It carries three things worth keeping:

- **The audit that motivated the change** — counted from the tree at `b57296e`, before the revamp: 1,109 raw `white/N` utilities against 352 token utilities, light mode broken outside `/me`, sixteen org links in one unwrapped row, three duplicate stat cards, no chart grammar, four competing page widths.
- **The token system** — the ink ramp and its contrast figures, the two-token accent, the status tones, and the six-hue categorical palette with the colour-vision-deficiency numbers it was validated against.
- **A working mockup** of the org dashboard in both themes, with the rail, the chart marks and the badge treatments.

### What this is and is not

This is a **point-in-time pitch**, not living documentation. It describes the state of the app *before* the revamp and argues for a direction; it is not updated as the app changes.

For the rules that apply to code you are writing now, read
[`apps/web/CLAUDE.md`](../../apps/web/CLAUDE.md) — that file is the source of truth for tokens,
primitives, chart conventions and navigation, and it records which parts of the migration are
still outstanding.

### Why the file is large

~183 KB, because the Syne / DM Sans / IBM Plex Mono faces are embedded as base64 `@font-face`
data URIs. Typography is part of the argument the document makes, so a silent fallback to a system
stack would misrepresent it. The tradeoff is deliberate: one self-contained file that renders the
same offline, in review, and years from now, instead of a small file that depends on a font CDN
still being there.
