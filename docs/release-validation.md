# Publication checks

## v1.6.5 — account-bound re-login and per-provider routing (2026-09-06)

- Final local validation: **1,500 tests passed, 0 failed, 0 skipped** with native-browser discovery enabled; production build and flat renderer/shared type-check passed. The isolated production desktop completed **62/62 checks** and quit cleanly. The broader main-process type-check still reports pre-existing prompt/client-detector/tool-parser typing errors; it is not reported as a clean project-wide type-check.
- Every built-in account has a direct re-login entry. Matching verified credentials update the original account atomically, retaining custom labels, enable/disable, cooldown and quotas. Arena reuses the original application-owned profile; identity mismatches and late results cannot replace the saved account. Custom API accounts expose credential editing rather than an unrelated OAuth flow. Legacy records without a verifiable identity are not silently declared restored.
- Providers independently choose inherited, system, direct or a specified HTTP/HTTPS/SOCKS5 proxy. Login, credential checks, model discovery, chat and delayed cleanup callbacks keep one routing snapshot per operation. Dedicated transport sessions are keyed by provider and normalized route, not the destination hostname. Invalid or multi-rule proxy addresses are rejected rather than silently downgraded to direct connections.
- An independent actual Electron loopback fixture passed **19/19 checks**, including concurrent direct traffic and two spy proxies to the same host, custom-address changes, no direct fallback on proxy failure, cookie isolation, preserved in-flight SSE, and idle keep-alive connection retirement. Z.ai's owned browser session postpones route switching while requests are active and queues new requests during the switch.
- Arena cannot infer whether a visible manual website chat has ended from the API request lock alone. It therefore never automatically closes a live browser to change its proxy. New operations stop with `route_changed`; after the user closes that window, the original profile can reopen with the new route. No message is automatically resubmitted.
- The desktop fixture verifies real provider-setting UI, preload and persistence. Its Kimi re-login result is synthetic at the account IPC boundary; the separate Z.ai fixture exercises the real browser, encrypted store, authentication IPC, liveness and two-turn OpenAI continuation against local website responses. Permanent fixture network isolation remains effective when production code replaces its own webRequest listener. These are not live certifications of every built-in login flow.
- Normal deployment restart succeeded without forced termination. Configured and actual API port are both **8081**, with health and model-list HTTP **200**. Read-only route inspection reports the saved Z.ai, DeepSeek and Arena providers inheriting system mode and resolving **DIRECT** on this machine. No system settings or guessed custom proxy address were applied. DeepSeek remains in its existing cooldown and was not retried.
- After deployment, one explicit liveness check of the existing Z.ai account using **GLM-5.3-Flash** passed with HTTP **200** and a complete reply. This sampled direct-route result does not certify an external proxy, all accounts or all models.

**Boundary:** route resolution is not connectivity or authentication verification. The loopback results do not prove that a user's external proxy is running or can access every website. Real website verification, subscription and quota restrictions remain in effect. No real account credentials, browser profiles, raw responses or local diagnostic artifacts are published. GPL notices and the original copyright are retained.

## v1.6.4 — website-backed Z.ai liveness and conversation continuity (2026-09-06)

- Final local validation: **1,430 tests passed, 0 failed, 0 skipped** with native-browser discovery enabled; production build and flat renderer/shared type-check passed. Isolated production Electron completed **56/56 checks** and quit cleanly.
- Reproduced the reported discrepancy: the saved account could restore the signed-in website, while the old independent chat transport returned HTTP **403 / captcha_required**. Login validation and chat-specific website preparation were different flows; no visible CAPTCHA was required to reproduce the failure.
- Z.ai now submits through an account-owned official chat page, sharing only that account's verified browser session. The website performs its own normal preparation. The bridge verifies the actual submission's account identity, captures only that response, rejects mismatched inputs/options and holds a per-account lease until complete EOF. It does not fabricate browser metadata, copy verification proofs, replay a failed generation or disturb the separate login/manual-chat page.
- Real testing exposed a second fault: complete replies without an SSE assistant ID were incorrectly rejected at conversation commit. After EOF, the bridge now verifies the exact submitted assistant/user/previous-parent relationships in that chat's saved graph before releasing the terminal frame. A contradictory SSE ID cannot override this verified cursor. Typed continuation errors are preserved in API responses, logs and tool-test guidance.
- The production fixture exercises real renderer/preload/account IPC, the browser manager, encrypted fixture storage and two complete local OpenAI route calls. Only the website is replaced by protocol fixtures. It verifies ID-less replies, an intentionally conflicting terminal ID, same-chat continuation with a new assistant node, current-input-only submission, and independent login/API pages. No production profile or real website is used by this fixture.
- **Sampled real-account result:** GLM-5.3-Flash on the existing Z.ai account passed actual account liveness with HTTP **200** and a complete reply. After deploying the cursor repair, the real settings tool-test service also passed **both HTTP 200 turns**: a declared tool call, then the harmless local result and a correct reply in the same conversation.
- The app was restarted normally, with **no forced process termination**. The proxy reports configured and actual port **8081**, health HTTP **200**, and model-list HTTP **200**. Z.ai is ready; the existing DeepSeek account remains in cooldown and was not retried. Overall catalogue diagnostics therefore still report that another provider needs attention.
- Separate Chinese GLM fixtures now cover content carried in the final frame and preservation of authentication/rate-limit status codes. These parser and error-mapping results are not a real Chinese GLM account test.

**Boundary:** this is a sampled Z.ai GLM-5.3-Flash liveness and non-streaming OpenAI tool-flow result, not certification of every model, provider, account or streaming client. Future website verification may still require user interaction in the actual chat page. The new Z.ai bridge is text-only and does not implement upstream chat deletion; tests may leave website conversations. No real credentials, account IDs, raw chat responses, logs or local diagnostic artifacts are published.

## v1.6.3 — account-bound Z.ai website restoration (2026-09-06)

- Final local validation: **1,327 tests passed, 0 failed, 0 skipped** with native-browser discovery enabled; production build and flat renderer/shared type-check passed. Isolated production Electron completed **52/52 checks**.
- Existing Z.ai accounts now open their own isolated website window and restore only that account's saved token. A same-origin authenticated profile request must establish a non-guest identity matching the saved account before the main process commits credentials. Token shape, an opened window, and HTTP 200 alone are not treated as login proof.
- Optional cookie rejection no longer aborts restoration. The website owns token refresh; verification uses its current Bearer token without cookie fallback instead of repeatedly replacing it with response tokens.
- Credentials are saved automatically to the original account with concurrent-change checks and a read-back verification. Unedited form fields cannot overwrite the saved token. Manual enable/disable, cooldowns, custom labels and limits are preserved; the website stays open.
- The complete production fixture exercises the real renderer, preload, account IPC, BrowserWindow and encrypted account store. Only the website is replaced with a local protocol fixture; the new login IPC is not mocked. It verifies automatic save, signed-in website rendering, window reuse, unchanged-credential handling and account deletion cleanup.
- **Sampled real-account result:** authenticated website restoration and saving passed; the user also confirmed the logged-in chat page. After a normal application restart, restoration passed again from the saved account, retaining the same account and scheduling controls. No chat was generated by these checks.
- The deployed proxy reports configured and actual port **8081**, with health and model-list HTTP **200**. Z.ai is available for selection; DeepSeek remains in its existing cooldown and was not retried.

**Boundary:** these results verify website login restoration and persistence, not successful chat generation, tool calling, or clearance of a chat-specific CAPTCHA. No real credentials, account identifiers, website response bodies or local diagnostic reports are published.

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
