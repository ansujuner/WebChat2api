# WebChat2api modifications

Modified: **2026-09-06**. This is a maintained derivative of the supplied
Chat2API working copy, not an official release of any AI provider.
The original copyright and **GPL-3.0-or-later** grant are retained in
[NOTICE](NOTICE); the complete GNU GPL v3 text is in [LICENSE](LICENSE).

## Changes from the supplied project

- Updated provider mappings and browser/runtime compatibility.
- Reused upstream website conversations; only the new turn is submitted.
- Added Claude Code/Anthropic compatibility and repaired tool-call testing,
  response parsing and first-turn-only tool/system instructions.
- Fixed actual/configured proxy port reporting and system proxy handling.
- Improved account identity labels, validation and request accounting.
- Added Arena account-owned browser login, dynamic text/image catalog,
  UUID v7 protocol IDs, conversation continuation and single-image output.
- Added per-account manual enable/disable and provider-directed suspension
  recovery. Manual disable is independent of automatic cooldown.
- Added per-account/model Arena quota tracking, conservative Seedream limits
  and provider-reported retry timing without automatic generation retries.
- Replaced provider brand placeholders with website-sourced local icons;
  retained the application's own branding and generic interface controls.
- Hardened error/stream completion handling, configuration boundaries and
  project-scoped Windows restart scripts; expanded regression coverage.

## Corresponding source and reproduction

Source is under `src/`; build configuration, `package-lock.json`, `build/`,
scripts and tests are included. With Node.js 24 and npm installed:

```text
npm ci
npm test
npm run build
```

Windows local deployment: see [docs/local-deployment.md](docs/local-deployment.md).
Provider and protocol limitations are documented under `docs/`.
Publication test coverage and remaining live-check limits are recorded in
[docs/release-validation.md](docs/release-validation.md).
The desktop application identifier/data location is intentionally retained
so existing accounts are not silently moved to an empty profile.

This initial publication is **source only**; it does not publish a compiled
installer or claim that every upstream model has been live-tested. If you
distribute binaries later, provide matching complete source, license and
notices and review dependency/asset terms. The release workflow must only
be triggered for a reviewed source tag.

GPL reference: [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html).
