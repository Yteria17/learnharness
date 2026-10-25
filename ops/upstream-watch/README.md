# Daily upstream watch on the VPS

Runs at **09:00 Europe/Paris**, including daylight-saving changes, through a
systemd user timer on `ubuntu@91.134.138.188`. User lingering is enabled, so the
Mac, Codex desktop and SSH connection need not stay open. A missed run is caught
up when the VPS/user manager restarts. Overlapping runs are prevented by a lock.

The installed application lives in `~/learnharness-upstream-watch/app/`, separate
from the disposable clone/worktrees and from the LearnHarness sync storage.
It uses the existing Codex CLI ChatGPT login and GitHub CLI login on the server;
no API key or credential is copied from the Mac. Successful recurring runs use
ChatGPT/Codex quota. No model call occurs when upstream is already integrated or
an unchanged manual decision is pending.

## Policy

The controller fetches the actual default branches and compares commit ancestry,
not a rolling 24-hour window. Codex reviews an isolated attempted merge in a
read-only sandbox without network-enabled model tools or user-configured MCP
servers. It reports structured analysis; it cannot perform the GitHub writes.

A deterministic guard prevents auto-merge for sensitive files, conflicts, large
batches, unresolved prior declines, uncertain analysis, any reported risk or any
negative/missing safety flag. Sensitive paths include our Electron adaptations,
sync scripts, store/server code, dependencies, tests, workflows, authentication,
settings, reasoning, demos and update system. A simple change must also preserve
the expected behavior and our fork features according to the code review.

The source commit is mirrored onto `automation/upstream-sync` **only in our fork**,
without force-pushing or following tags. A PR against the fork's default branch
contains the complete upstream batch. Conflicts remain visible for human review;
the runner never silently chooses one side. A pending PR is reused. Closing it
without merging preserves the decision for the same upstream revision. Human
text outside the bot's marked body section is retained.

For a simple batch, all four jobs of this fork's `.github/workflows/ci.yml` must
succeed for the exact PR/head revision. Missing, skipped, failed, cancelled,
unrelated and upstream-repository checks do not qualify. The controller rechecks
the base/head and mergeability, then uses a PR merge guarded by the reviewed head
SHA. It does not bypass branch protections, resolve conflicts, or cherry-pick a
subset of a mixed batch. Changes while testing defer integration to a later run.
CI waits are bounded; failures remain in the PR and local report.

**No tag, release, app deployment or VPS sync configuration is created/changed.**
Merging into main does not publish an app update. A release remains a separate
human decision. This timer is independent of the proposed desktop automation;
do not activate both for the same repository.

## Operations

```sh
systemctl --user list-timers learnharness-upstream-watch.timer
systemctl --user status learnharness-upstream-watch.service
journalctl --user -u learnharness-upstream-watch.service
cat ~/learnharness-upstream-watch/latest.json
systemctl --user start learnharness-upstream-watch.service
systemctl --user disable --now learnharness-upstream-watch.timer
```

Reports and restricted logs are under `~/learnharness-upstream-watch/`. PRs are
visible in `Yteria17/learnharness`; they are not automatically posted into a Codex
chat. A service failure is recorded in `failure.json` and the systemd journal.
The service limits CPU/memory. Codex itself
runs in a read-only sandbox; its model tools cannot write to the VPS or make
network requests. The controller writes only its own state/checkout and the
specified GitHub branch/PR. It does not run npm lifecycle/build scripts on the VPS;
the existing full CI runs tests and platform/server checks on GitHub runners.

Install/update: copy `run.py`, `review-schema.json` and `review-prompt.txt` from a
reviewed revision into `~/learnharness-upstream-watch/app/`; install the provided
units under `~/.config/systemd/user/`, validate them with `systemd-analyze --user
verify`, reload the user manager, and enable the timer. Keep the already existing
CLI sign-ins; never commit credential files. Run the unit once and inspect the
result before treating deployment as verified.

Tests: `python3 -m unittest discover -s ops/upstream-watch -p 'test_*.py'`.
