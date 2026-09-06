# v1.5.0 publication checks

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
