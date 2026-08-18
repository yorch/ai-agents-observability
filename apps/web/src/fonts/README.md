# Vendored fonts

Latin subsets of the app's three faces, self-hosted so `next build` has no
network dependency on fonts.googleapis.com (which broke Docker builds on
restricted builders and was a silent deploy-time flake otherwise):

- `syne-700.woff2` — Syne, weight 700 (display)
- `dm-sans.woff2` — DM Sans, variable (used at 400/500; UI text)
- `ibm-plex-mono-{400,500}.woff2` — IBM Plex Mono (data/numbers)

All three are licensed under the SIL Open Font License 1.1. Files were
fetched from Google Fonts (css2 API, latin subset). Non-latin glyphs fall
back to the system stacks declared in `globals.css`.
