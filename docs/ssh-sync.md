# Personal SSH synchronization (manual preview)

The desktop app now integrates this engine automatically while the app is open, at startup and on quit.
See `automatic-sync.md` for **Settings → Sync**. The commands below remain an
optional recovery/administration tool; they are not needed for ordinary use.

This preview synchronizes the desktop learning profile through an existing SSH
account. It does not open a port, install a daemon, or execute AI requests on the
VPS. Quit LearnHarness on the current computer before running it. Run it before
opening the app and after quitting, especially before changing computers.

## What is synchronized

- Conversations and practice transcripts (`chats/*.json`).
- Graph ledgers, imported-note metadata, graph positions and appearance settings.
- Nonsecret application settings and custom prompt Markdown files.

API keys, ChatGPT credentials, OS secure-storage state, pending background jobs,
logs, caches, and external source files are excluded. An exercise's committed
solution and outcomes travel in its conversation. Original PDFs or notes stored
elsewhere on disk do not travel with this preview. Sign in with ChatGPT separately
on each computer. Do not launch an older app against the synchronized profile.

## Server installation

Requires Python 3 on Linux and a normal SSH account. Install
`scripts/sync/sync-store.py` as
`~/.local/share/learnharness-sync/sync-store.py`, readable by that user only.
The process is started on demand by SSH. Data lives in the sibling `state/`
directory, protected by Unix file permissions and SSH encryption in transit.
Data is not encrypted separately at rest on the VPS.

The server retains a complete snapshot of each accepted revision in
`state/history/`. Include that directory in your VPS backups. No automatic
pruning is performed in this preview; monitor disk usage. Maximum snapshot:
64 MiB of synchronized file contents, 20,000 files.

## Client

Requires Node.js 22+ and OpenSSH (`ssh`). The local desktop Electron executable
can also run the client with `ELECTRON_RUN_AS_NODE=1` (the macOS launcher in the
delivered bundle does this, so Node need not be separately installed).

Configure SSH key authentication on every computer. Verify the server host key
using a trusted fingerprint on first connection; the client deliberately refuses
unknown or changed host keys and interactive password prompts. SSH host aliases
can carry a custom port and IdentityFile in your normal SSH configuration.

```sh
node sync-data.mjs status --host user@server
node sync-data.mjs sync --host user@server
```

Default desktop data directories:

| System | Data |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/data` |
| Windows | `%APPDATA%/LearnHarness/data` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/LearnHarness/data` |

Use `--data /absolute/path` only for an explicitly chosen alternate profile.
`status` does not upload or download. It reports the direction of the next sync.
On a new, empty computer, sync downloads the server's profile. The first computer
uploads its profile into an empty server. On a previously synchronized computer,
the tool compares local and remote contents with their last shared revision.

## Conflicts and recovery

Independent files and preference keys merge automatically, as do compatible
append-only graph ledgers. Incompatible concurrent changes to one session or
field are refused without replacing either copy. Preserve both profiles for manual reconciliation. Likewise, a first-time
connection refuses to replace an unrelated, nonempty profile. There is no force
flag. Switching computers successively, with a sync before and after each use,
avoids this case.

Each download stages the complete replacement locally, preserving excluded
machine-local files. The previous data directory is moved into
`LearnHarness/sync-backups/<timestamp>-<uuid>/` before the staged directory is
installed. Individual file renames are atomic; the two-directory swap is not a
single filesystem transaction. If power fails between the two renames, keep the
app closed, locate `.sync-stage-*` and `sync-backups/`, and restore a complete
directory to `data` before continuing. A normal install failure rolls back.

The last acknowledged revision and file checkpoint are in
`LearnHarness/ssh-sync-state.json`. Keep it with
that computer's profile; it is not a credential. A local exclusive
`ssh-sync.lock` prevents two clients running simultaneously. After an interrupted
run, confirm that no sync process is running before removing that lock.

The tool checks for a running desktop app but cannot detect every custom
development server. Close development instances manually. This optional CLI is manual; the desktop integration uses the same engine
with server-owned checkpoints and automatic background polling. It is not
simultaneous collaborative editing of one conversation.

## Validation

```sh
node --test scripts/sync/sync-data.test.mjs
python3 -B scripts/sync/test_sync_store.py
```

Tests cover independent edits, deletions, initial profile collisions, credential
exclusion, symlink/path traversal, concurrent server uploads, revision history,
and a failed server commit preserving the previous head.
