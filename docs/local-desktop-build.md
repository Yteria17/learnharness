# Personal macOS build with ChatGPT sign-in

The 0.3.5 source includes the desktop ChatGPT provider. The published 0.3.4
installer does not. In the new desktop app, open **Settings → Providers →
Subscriptions → Continue with ChatGPT**, complete browser sign-in and plan-use
consent, then select ChatGPT models under **Agent**. Each computer keeps its own
connection in OS-encrypted storage. The real account sign-in must be completed
by the user; deterministic tests do not prove a particular account is eligible.

For a personal build on Apple Silicon, use Node.js 26 and the local configuration:

```sh
npm ci
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
npx electron-builder --mac dmg --arm64 --publish never --config electron-builder.local.yml
```

This configuration uses the existing ICNS icon (no full Xcode installation
needed), signs ad hoc, skips Apple notarization, and omits the upstream update
feed. It is a personal development build, not a notarized production release.
It leaves the production signing configuration unchanged. The macOS hardened
runtime is disabled for this ad-hoc build because it otherwise rejects the
Electron framework's different signing team at launch.

The app uses the existing `LearnHarness` data directory. Back up that directory
before replacing an older app. Quit all copies before installing or synchronizing.
If macOS denies terminal replacement of `/Applications/LearnHarness.app`, install
the generated DMG using Finder. Do not merge app bundles in place.

Windows and Linux must build their standalone server payloads on their own OS;
do not ship a macOS standalone tree on another platform. See `desktop-release.md`
for their build pipeline. The SSH sync preview is described in `ssh-sync.md`.
