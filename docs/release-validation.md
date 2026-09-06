# Publication checks

## v1.6.2 — existing-account re-login (2026-09-06)

- Final local validation: **1,272 tests passed, 0 failed, 0 skipped** with native-browser discovery enabled; production build and flat renderer/shared type-check passed. Isolated production Electron completed **48/48 checks**.
- The production renderer now exposes **Edit Account → OAuth Login → Sign in again** for existing non-Arena built-in website accounts. Manual editing remains available; custom API accounts and existing Arena profiles are not given an unrelated OAuth flow.
- Component regressions cover duplicate operations, failure/incomplete results, known identity mismatches, close/reopen/account switches, stale validation and explicit-save ownership.
- The isolated production Electron check clicks the Z.ai account menu, opens its edit dialog and OAuth tab, invokes the real preload, then supplies a synthetic OAuth response at the IPC boundary. It verifies draft-only credentials before save, updating the original account rather than creating a duplicate, retaining custom labels/limits/disable/cooldown/old authentication status, and rejecting a late response after cancellation.
- This is **not a live website login or CAPTCHA check**: the OAuth response is deliberately synthetic, no real login window is opened, and all account data lives in the disposable workspace fixture. Restoring an expired/error authentication state requires the account-list validation action after saving; liveness separately checks chat availability.
- The same fixture caught a missing `credentialFields` copy when creating a built-in provider in the current process: Z.ai was incorrectly requiring `jwt` rather than `token` until restart. This creation path is now covered rather than bypassed by test-only provider configuration.
- Encryption diagnostics no longer print plaintext, ciphertext, or decrypted credential fragments. Focused tests also verify that native encryption errors cannot leak the supplied value into logs. Existing storage fallback policy is unchanged.

## v1.6.1 — tools and custom providers (2026-09-06)

- Final local run: **1,255 tests passed, 0 failed, 0 skipped** (optional native-browser discovery enabled); production build succeeded. The isolated production Electron smoke completed **44/44 checks**, including real UI interactions and loopback HTTP exchanges. The four additional website-parser paths passed **37/37** focused checks.
- Custom-provider checks exercise the production renderer: open the creation form, reject an invalid URL without saving, save a normalized Base URL, open the account dialog, and save its API key in the isolated account store.
- A loopback HTTP fixture verifies authenticated model discovery, redacted errors, retained model configuration, editing, and deletion. It is not a public AI service or a real account.
- The real tool-test IPC completes both turns for the standard OpenAI and Cherry Studio adapters. Both OpenAI Chat Completions and Anthropic Messages complete streaming and non-streaming native tool exchanges, retaining structured tools and their corresponding results.
- The actual tool-test UI button also passes against this fixture. A separate HTTP 403 fixture produces an account-blocked result, safe guidance, and exactly one request rather than a parser-failure claim or an automatic retry.
- Website stream regression fixtures cover managed tool parsing for Z.ai, Qwen AI, Perplexity, and MiniMax, including split markers, declared-tool boundaries, and incomplete streams. These are parser/protocol checks, not live account certifications.

**Live boundary:** the sampled existing Z.ai account required a captcha before generating a reply; the existing DeepSeek account was cooling down. Code, fixture, and health-check passes must not be presented as successful real tool calls on either blocked account. Complete website verification or wait for recovery before manually testing again.

The original copyright, GPL notices, and account storage identifiers remain unchanged. No account profiles, keys, raw provider messages, or local diagnostic reports are published.

## Historical v1.5.0 publication checks

Checked on Windows on 2026-09-06. This is a source publication, not an installer release or a guarantee of provider availability.

## Reproducible local checks

- `npm test`: **992 passed, 0 failed, 0 skipped** with the optional native-browser-discovery tests enabled by `CHAT2API_TEST_NATIVE_BROWSER_DISCOVERY=1`.
- `npm run build`: production main process, preload and renderer built successfully.
- `node scripts/smoke-app.cjs`: **17 checks passed** using an isolated temporary profile and fake accounts. Includes actual Electron startup, renderer/preload, proxy port reporting, account enable/disable, timed cooldown expiry and preservation of manual disable.
- Runtime exercised: Electron 44.2.0, Chromium 152.0.7977.76. No claim is made for macOS/Linux runtime testing.

Restriction and quota tests inject structured local fixtures; they do not deliberately ban accounts or exhaust upstream allowances. The tests cover persistence, concurrency, rolling quota windows, unavailable credentials, retained conversation bindings and safe error propagation.

## Sampled upstream verification

- Arena login and authenticated model discovery succeeded.
- `arena/text/max`: first reply and same-conversation continuation both returned HTTP 200 and preserved the requested marker.
- `arena/image/max`: one image generation returned HTTP 200 and a validated image URL.
- These are sampled checks, **not tests of every catalogue entry or of Seedream's actual hourly allowance**. The Seedream local five-per-hour default is user-supplied; see [account scheduling](account-scheduling.md).
- DeepSeek live tool verification encountered an upstream restriction response and was stopped without retrying. Local passing tests do not establish live DeepSeek tool availability while an account is restricted.

## Publication boundaries

The published source excludes account stores, credentials, browser profiles, local logs, diagnostic reports, captured traffic and generated outputs. Provider responses and machine/account identifiers are not included here. Original notices, the full GNU GPL v3 license, modification notes and separate brand-asset provenance are retained.

See [local deployment](local-deployment.md) for repeatable startup and opt-in live checks. Authentication and site verification are performed through the website; this application does not promise to bypass them.
