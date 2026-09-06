# WebChat2api modifications

Modified: **2026-09-06 through 2026-09-07**. This is a maintained derivative of the supplied
Chat2API working copy, not an official release of any AI provider.
The original copyright and **GPL-3.0-or-later** grant are retained in
[NOTICE](NOTICE); the complete GNU GPL v3 text is in [LICENSE](LICENSE).

## Changes from the supplied project

- Source release preparation (2026-09-07): explicitly install the pinned Electron
  runtime before native dependency preparation during `npm ci`. Electron 44's
  package does not perform that download automatically. Added installation
  regression checks and direct clean-source download instructions; provider
  behavior, account storage and dependency versions are unchanged.

- v1.6.6 (2026-09-06): fixed installed-browser login startup from an elevated
  Windows launcher by delegating to the existing ordinary-user desktop shell,
  without weakening browser sandboxing or disabling Chrome's de-elevation.
  Added safe, translated login-stage errors and retained Arena browser ownership
  after disconnected pipes so a live profile cannot be launched twice. Added
  explicit original-account Arena restoration diagnostics; no new profile is
  substituted when the original cannot be restored.

- v1.6.5 (2026-09-06): added direct account-bound re-login for all built-in
  providers, including reuse of Arena's original browser profile, identity
  checks and atomic updates that preserve account controls. Added per-provider
  inherited/system/direct/custom proxy routing across login, validation, model
  discovery, chat and cleanup. Proxy decisions are scoped to each operation,
  not guessed from hostnames; fixed proxy endpoints are strictly validated.
  Added read-only route diagnostics and isolated concurrent-proxy/UI fixtures.
  System proxy resolution does not certify connectivity or website access.

- v1.6.4 (2026-09-06): routed Z.ai account liveness and API chat through the
  account's normal website submission flow instead of an independent request
  with fabricated browser metadata. Added isolated API pages, bounded response
  capture, identity checks, per-account submission locks and cancellation;
  verification prompts no longer incorrectly point only to the login page.
  Continuation cursors are verified against the submitted chat's saved message
  graph before completion; missing cursors retain their diagnostic error code.
  Also fixed GLM terminal-frame content loss and preserved authentication and
  rate-limit HTTP errors. Live availability remains subject to website checks.

- v1.6.3 (2026-09-06): added account-bound Z.ai browser restoration using only
  that account's saved credentials. Website identity, not a JWT shape or an
  opened window, gates an atomic save to the original account. The website stays
  open; stale form saves cannot overwrite refreshed credentials. Added a complete
  production UI/browser/storage fixture and an explicit, redacted real-account
  restore diagnostic. This does not certify chat CAPTCHA clearance.

- v1.6.2 (2026-09-06): restored the missing OAuth entry when editing an
  existing non-Arena website account. Re-login requires explicit save to the
  original account and preserves scheduling controls. Added UI lifecycle and
  stale-login regression checks, copied first-created providers' credential
  definitions immediately, and removed credential fragments from encryption
  diagnostics. Refreshing login is not proof that a website
  captcha or chat restriction has been resolved.

- v1.6.1 (2026-09-06): restored native custom-provider tools and stateless
  tool-result round trips; classified upstream verification/auth/quota blocks
  separately from tool parsing. Enabled custom-provider creation, editing,
  API-key accounts and read-only model discovery with validated configuration.
  Added production IPC and both API protocols' streaming/non-streaming tool
  checks against a loopback-only fixture, not real account simulations.

- v1.6.0 (2026-09-06): refreshed the application visual system, original
  WebChat2api artwork, dashboard introduction and local connection display.
  Chinese is the new-install default; existing language choices are retained
  and English remains available from the header. Replaced historical images
  with isolated current-version captures and made the repository homepage
  Chinese-first with a matching English edition. Provider trademarks, storage
  identifiers, account data and GPL notices are preserved.

- v1.5.1 (2026-09-06): added exact-account real-message liveness checks,
  serial provider/all-account batches, cancellation of queued checks, safe
  progress reports and independent credential-validation controls. See
  [account liveness](docs/account-liveness.md).

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
  application artwork is independently refreshed in v1.6.0.
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
