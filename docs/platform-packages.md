# macOS / Linux packages

The `macOS and Linux packages` workflow packages an existing `source-vX.Y.Z`
release without changing its tag, source archive, dependencies, or application code.
Build tooling comes from the workflow commit; the application comes from a separate
checkout of the selected source tag. Both commits are recorded in the published
`BINARY-MANIFEST.json`.

Native jobs copy these checkouts into a fresh short `/tmp/cXXXXXX` build directory
before installing dependencies. This prevents Chromium's `SingletonSocket` path
from exceeding POSIX socket limits inside the otherwise isolated test profiles;
it does not change application code or disable single-instance protection.

## Targets

| Platform | Native runner | Files |
| --- | --- | --- |
| macOS Apple Silicon | macos-15 / arm64 | DMG, ZIP |
| macOS Intel | macos-15-intel / x64 | DMG, ZIP |
| Linux x64 | ubuntu-24.04 / x64 | AppImage, DEB, tar.gz |
| Linux ARM64 | ubuntu-24.04-arm / arm64 | AppImage, DEB, tar.gz |

Node 24.13.0 and the released npm lockfile are used. Linux's native FPM 1.15.1
builds the DEB package. macOS bundles receive a local ad-hoc signature with
Electron's standard entitlements, **not an Apple Developer ID signature or
Apple notarization**. The packaging-only configuration disables Hardened Runtime
for these ad-hoc bundles. A normal Internet download may be blocked by Gatekeeper;
these packages do not claim a trusted-identity or notarized installation experience.

The AppImage packaging override replaces electron-builder 25's implicit
`--no-sandbox` argument with `--no-first-run`. Linux must provide working Chromium
sandbox support; DEB is preferred when the distribution restricts user namespaces.
This workflow does not disable system security controls or add `--no-sandbox`.

Automatic external Chrome/Edge login currently supports Windows only. These
macOS/Linux packages retain the providers' other existing authentication methods;
they do not add platform support to Windows-only login features.

## Gates before upload

1. Confirm the source version/tag and native runner architecture.
2. Fresh `npm ci`, regression tests, strict main/renderer type checks, and build.
   Windows-only regression cases remain explicitly skipped on non-Windows hosts.
   The v1.6.7 test fixture references `loadBalancer.ts` rather than the tracked
   `loadbalancer.ts`. The runner corrects this single test-only path for the
   regression suite, records the correction, then restores the original test
   before building. No assertion is removed and no application input is modified.
3. Run the existing isolated production-application smoke checks, with only local
   synthetic fixtures and no real provider accounts or production profiles.
   macOS tests create a new unlocked Keychain within each isolated HOME, including
   the native preferences directories, instead of using the runner's existing
   keychains. Each test removes only its own Keychain. Native `safeStorage` is not mocked.
4. Inspect every ASAR build/legal file and external icon/WASM byte against the
   build inputs; check the executable's Mach-O/ELF architecture.
5. Extract every installer without installing it, compare contained ASAR/resources,
   validate macOS signatures and DEB architecture, and inspect AppImage arguments.
6. Launch the actual packaged application on its native runner with a fresh HOME
   and Chromium profile, verify UI/preload/version/architecture/empty accounts,
   and require clean single-instance command shutdown.
7. Only after all four native jobs pass, attach ten binaries, four compact build
   reports, an aggregate manifest and binary SHA-256 checksums to the existing
   source release. Original source archives/checksums remain untouched.

Uploads never overwrite existing assets. All local caches, test profiles, raw
runtime output, accounts, and test credentials remain out of published packages.
Passing these checks is not a substitute for real-account provider testing, every
supported distribution/OS version, or Apple signing/notarization.
