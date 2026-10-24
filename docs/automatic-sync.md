# Automatic live desktop synchronization

The desktop app synchronizes saved learning data over SSH while it stays open.
It sends changes shortly after committed writes (a one-second debounce), checks
for peer updates every ten seconds, and also synchronizes at startup and quit.
These are retry intervals, not a guaranteed transfer latency: network outages,
long responses, and running background jobs can defer an import.

Open **Settings → Sync**, enter `user@server` or an SSH alias, enable automatic
synchronization and save. **Sync now** requests an immediate cycle without
restarting. The sidebar shows the last successful transfer, a waiting state,
network failure or conflict. Each computer needs SSH key access and a trusted
server host key. The existing SSH server is the only network service required.

On macOS, closing the last window keeps the app resident, including its sync
loop. Quitting still performs a final synchronization. There is no need to quit
one computer to retrieve its saved work on another.

## Consistent checkpoints and imports

Snapshots are captured synchronously inside the local server process that owns
all learning-data writes. An in-progress model turn, compaction or wake delivery
is allowed to finish before its checkpoint is published. Partial streamed text
and unsubmitted drafts are not shared.

Incoming data is applied inside that same process, only after checking that:

- no mutating request, model turn, compaction, extraction or background job is active;
- the current local file fingerprint still matches the captured checkpoint.

All POST/PUT/PATCH/DELETE handlers, apart from the synchronization endpoint
itself, participate in a shared request barrier. This covers handlers suspended
at an await before a later write. The final checks and directory replacement are
synchronous, so a new request cannot interleave with that replacement. A busy or
changed local profile defers the import and retries automatically.

Peer imports emit server notifications. Mounted conversations, the sidebar,
graph and preferences refetch in place; the window is not reloaded. Importing a
conversation does not start an AI continuation. A local turn starting during a
refetch prevents that refetch from replacing the live transcript.

## Merges, conflicts and offline use

A file-level base checkpoint is kept locally, outside the shared profile.
Independent session files merge automatically. JSON preference maps merge
independent keys. Graph ledgers can combine append-only branches, preserving
within-branch order; ambiguous identities and rewrites are rejected.

Concurrent incompatible edits to the same session or field are reported as a
conflict. Neither local copy is overwritten. This is data synchronization, not
simultaneous collaborative editing of one conversation. There is no force flag.

Transfers use server-side compare-and-swap. An immutable checkpoint may be
uploaded while later local writes continue. If a merged checkpoint was accepted
remotely but its local import is deferred, the acknowledged local checkpoint is
retained so the next cycle can rebase those later writes correctly.

Offline work remains local; retries continue automatically. Normal quit waits
for an active transfer, then stops the server and performs a final sync. A failed
quit sync offers Retry or Quit keeping local changes. After an interrupted host,
the app can recover a lock owned by a process that no longer exists; living
owners' locks remain untouched.

## Data and credentials

Shared: conversations and practice transcripts, graph ledgers and layout,
nonsecret settings, custom prompt Markdown, screenshot attachments and documents
explicitly added to the library (including originals of new notes imports).
Other external files, logs, caches and active job files do not transfer. ChatGPT credentials and SSH
private keys stay on each computer. Connect ChatGPT separately on each device.

`desktop-sync.json` stores this computer's host, enable flag and last success.
`ssh-sync-state.json` stores its last acknowledged revision and file checkpoint.
Neither file is included in the learning snapshot. SSH encrypts transit; the VPS
stores snapshots under its user's filesystem permissions, without separate
at-rest encryption. The shared profile is limited to 1 GiB, 50 MiB per file and 20,000 files.
Protocol v2 transfers only changed files in bounded batches. New server histories
are manifests referencing immutable content-addressed objects; v1 histories remain intact.
All computers must upgrade to 0.3.7-fork.1 before using a v2 profile.

Every accepted server revision is retained; each local import keeps the previous
profile in `sync-backups/`. No automatic retention pruning is performed. Include
the server state in your normal backups and monitor available disk space.
Directory renames are individually atomic, not one multi-directory filesystem
transaction; see `ssh-sync.md` for interrupted replacement recovery.

## Implementation and validation

Electron owns timers, SSH, configuration and the narrow preload controls.
`POST /api/sync` is protected by the desktop capability checks in `proxy.ts`.
The store adapter captures and replaces data; the core barrier and server
registries exclude active writers. The renderer receives status and refetch
notifications, not SSH execution or credential access.

The deterministic suite checks lifecycle ordering, write barriers, debounce and
polling, retry, independent merges, conflicts and deferred-import rebasing.
A separate end-to-end check ran two standalone servers with isolated local
profiles and an isolated SSH profile on a VPS: transfer in both directions,
concurrent new sessions, busy-import deferral, and conflict preservation all
passed while both servers stayed open. No real LLM requests were used.
