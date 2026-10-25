# Automatic updates for this fork

Packaged Mac Apple Silicon and Windows x64 apps check the public releases of
`Yteria17/learnharness` at startup and every four hours. They download in the
background. A French banner offers **Redémarrer**; otherwise the update installs
when the user quits. The existing shutdown barrier stops the local server and
finishes SSH synchronization before installation. The General automatic-update
setting controls background checks and installation on quit. A manual menu check
and explicit restart still work when that setting is disabled.

Existing versions before 0.3.8-fork.1 need one manual installation to acquire this
updater. Linux installations retain manual updates.

## Release a version

1. Bump the version in package.json and package-lock.json; commit and merge.
2. Push a matching `v<version>` tag, or dispatch **Fork release and automatic
   updates** with **publish** enabled from the intended revision.
3. The workflow checks types/tests/lint, packages all three operating systems,
   signs the update manifest and exercises the real detached Mac/Windows
   installers in disposable directories. Only then does it publish the complete
   GitHub Release as the latest release. Drafts/partial assets cannot reach users.

The checked-in `electron/update-public-key.pem` is the app's trust anchor.
`LH_UPDATE_SIGNING_KEY` is the corresponding private Ed25519 key stored as a
repository Actions secret. It is needed only by the signing job and never goes
into the repository, packages or user profiles. Keep a secure backup. Changing
this trust anchor requires a migration/reinstallation; do not casually regenerate
it. Releases must stay public for anonymous downloads; no GitHub token is shipped.

The signed manifest binds repository, app ID, version, exact filenames, byte sizes
and SHA-256 hashes. Verification runs during signing, downloading, immediately
before spawning the helper, and again after the parent has exited. Downloads use
HTTPS from the fixed fork. A verified cached download remains available offline;
checks can still discover a newer release instead of getting stuck on the cache.

The helper runs outside the application bundle. Mac extracts its ZIP next to the
installed app, checks bundle ID/version and the bundle's code signature, then
swaps directories. One old copy is retained as `.LearnHarness.previous` (no `.app`
extension), and a failed replacement restores it. These personal Mac builds use
ad-hoc signatures; this update signature does not replace Apple notarization.
Windows uses the NSIS installer with the standard silent-update arguments and
installed directory. Settings, lessons, ChatGPT login and SSH keys stay in the
existing user-data directory. The VPS holds learning data, not application updates.

Installation diagnostics are in the local user-data `updates/install-result.json`
on Mac or on helper failure. Update/check errors go to the desktop log. Mac needs
write access to the installed app's parent directory. OS permission prompts still
apply. A working internet connection is needed to discover/download a new release.

Intermediate installer artifacts are kept for seven days. Signing metadata and
checksums are stored separately; publication reuses the original platform
artifacts instead of uploading a second full copy. Published release assets
remain available independently of the Actions artifact retention period.

## Validation

`tests/fork-updater.test.ts` covers signature tampering, fork isolation, manifest
bounds, cache recovery, coalesced downloads, corruption, unsupported targets,
rechecks before installation, Mac rollback and Windows arguments with spaces.
`scripts/updates/smoke-install.mjs` exercises production signed artifacts through
the actual updater/helper and real installer on Mac and Windows, preserving a
profile sentinel. Its mock transport serves the exact production release bytes;
GitHub publication/download availability is checked separately at release time.
