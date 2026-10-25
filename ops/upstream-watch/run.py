#!/usr/bin/env python3
"""Daily upstream review. The model has read-only access; this controller owns writes.

Only the source-mirror branch, PR bodies and a checked PR merge can be written.
There is deliberately no release/tag/deployment operation in this program.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

FORK = "Yteria17/learnharness"
UPSTREAM = "amosblomqvist/learnharness"
MIRROR = "automation/upstream-sync"
REQUIRED_JOBS = {"Typecheck, tests, lint", "Standalone (mac-arm64)",
                 "Standalone (windows-x64)", "Standalone (linux-x64)"}
SENSITIVE = re.compile(
    r"(^|/)(AGENTS\.md|SKILL\.md|package(?:-lock)?\.json)$|"
    r"^(electron|scripts|ops|\.github|src/store|src/server|src/agents|tests)/|"
    r"auth|sync|migrat|security|settings|sidebar|update|chatgpt|demo|question|"
    r"thinking|keyboard|library|attach|screenshot|provider|compaction|context|model",
    re.IGNORECASE)
START, END = "<!-- learnharness-upstream-watch:start -->", "<!-- learnharness-upstream-watch:end -->"


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def command(args, *, cwd=None, check=True, timeout=120, data=None):
    result = subprocess.run([str(a) for a in args], cwd=cwd, input=data,
                            text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed ({result.returncode}): "
                           + result.stderr[-2500:])
    return result


def git(repo, *args, check=True):
    return command(["git", "-c", "credential.helper=", "-c",
                    "credential.helper=!gh auth git-credential", "-c",
                    "user.name=LearnHarness upstream watch", "-c",
                    "user.email=learnharness-automation@users.noreply.github.com", *args],
                   cwd=repo, check=check)


def api(endpoint, method="GET", data=None):
    args = ["gh", "api", endpoint, "--method", method]
    if data is not None:
        args += ["--input", "-"]
    raw = command(args, data=json.dumps(data) if data is not None else None).stdout
    return json.loads(raw) if raw.strip() else None


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.chmod(0o600)
    temp.replace(path)


def blockers(files, conflicts, patch_bytes, previous_decline=False):
    reasons = []
    sensitive = [name for name in files if SENSITIVE.search(name)]
    if sensitive:
        reasons.append("Fichiers sensibles ou adaptations du fork : " + ", ".join(sensitive[:20]))
    if conflicts:
        reasons.append("Fusion conflictuelle : " + ", ".join(conflicts[:20]))
    if patch_bytes > 200_000 or len(files) > 30:
        reasons.append("Lot trop large pour une fusion automatique prudente.")
    if previous_decline:
        reasons.append("Une précédente PR du même lot amont a été fermée sans fusion.")
    return reasons


def simple(verdict, reasons):
    return (not reasons and verdict.get("analysis_complete") is True and verdict.get("risks") == [] and verdict.get("decision") == "simple"
            and all(verdict.get(key) is True for key in (
                "behavior_preserving", "fork_features_preserved", "no_security_or_data_change")))


def successful_ci(run, jobs, pr_number, head):
    """Do not accept missing, skipped, unrelated or upstream-repository checks."""
    return (run.get("event") == "pull_request" and run.get("head_sha") == head
            and run.get("path") == ".github/workflows/ci.yml"
            and run.get("repository", {}).get("full_name") == FORK
            and any(p.get("number") == pr_number for p in run.get("pull_requests", []))
            and run.get("status") == "completed" and run.get("conclusion") == "success"
            and REQUIRED_JOBS <= {j.get("name") for j in jobs}
            and all(j.get("status") == "completed" and j.get("conclusion") == "success"
                    for j in jobs))


def section(verdict, reasons, base, upstream, state, ci_url=None):
    risks = verdict.get("risks", []) + reasons
    text = (f"{START}\n## Veille quotidienne LearnHarness\n\n"
            f"{verdict.get('summary', '')}\n\n"
            f"**État : {state}.**\n\n{verdict.get('reason', '')}\n\n"
            f"Base du fork : `{base}`\n\nRévision amont : `{upstream}`\n\n")
    if risks:
        text += "Points à examiner :\n\n" + "\n".join("- " + str(r) for r in risks) + "\n\n"
    if ci_url:
        text += f"[Validation CI du fork]({ci_url})\n\n"
    text += ("La branche source reproduit uniquement les commits amont. Les adaptations du fork "
             "restent dans la branche de base et doivent être conservées à la fusion. "
             "Une fusion conflictuelle nécessite une résolution humaine ; aucun conflit n'a été résolu automatiquement.\n\n"
             "Fusion automatique uniquement pour un lot simple, sans fichier sensible, après la CI complète "
             "du fork sur la révision examinée. Utiliser une fusion avec conservation de l'historique, "
             "pas un squash, pour le suivi des commits amont.\n\n"
             "**Aucun tag, release ou déploiement n'est créé par cette tâche.**\n" + END)
    return text[:30000] if len(text) < 30000 else text[:29900] + "\n" + END


def update_body(pr, text):
    body = pr.get("body") or ""
    if START in body and END in body:
        a, b = body.index(START), body.index(END) + len(END)
        body = body[:a] + text + body[b:]
    elif body:
        body += "\n\n" + text
    else:
        body = text
    api(f"repos/{FORK}/pulls/{pr['number']}", "PATCH", {"body": body})


def review(checkout, root, base, upstream, reasons, logdir):
    context = (f"Fork : {FORK}\nAmont : {UPSTREAM}\nBase : {base}\nAmont : {upstream}\n"
               f"Blocages déterministes : {json.dumps(reasons, ensure_ascii=False)}\n\n"
               "Commits à examiner :\n" + git(checkout, "log", "--oneline", f"{base}..{upstream}").stdout
               + "\nFichiers du lot amont :\n" + git(checkout, "diff", "--name-status", f"{base}...{upstream}").stdout)
    (checkout / ".upstream-review-context.txt").write_text(context)
    output = logdir / "review.json"
    args = [str(Path.home() / ".local/bin/codex"), "exec", "--ignore-user-config",
            "--ephemeral", "--sandbox", "read-only", "-c", 'approval_policy="never"',
            "-c", 'model_reasoning_effort="medium"', "--color", "never", "--json", "--output-schema", str(root / "app/review-schema.json"),
            "--output-last-message", str(output), "--cd", str(checkout), "-"]
    prompt = (root / "app/review-prompt.txt").read_text()
    try:
        result = command(args, data=prompt, timeout=600, check=False)
        (logdir / "agent.jsonl").write_text(result.stdout)
        (logdir / "agent.stderr").write_text(result.stderr)
        if result.returncode or "bwrap: No permissions" in result.stdout + result.stderr:
            raise RuntimeError("Codex n'a pas terminé son analyse ; consulter le journal local.")
        value = json.loads(output.read_text())
        if (not isinstance(value, dict) or value.get("decision") not in ("simple", "review") or not isinstance(value.get("risks"), list)
                or not all(isinstance(value.get(key), str) for key in ("summary", "reason"))):
            raise ValueError("Réponse de revue invalide")
        return value
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        return {"analysis_complete": False, "decision": "review", "summary": "Nouveaux commits amont à examiner.",
                "reason": str(error), "risks": ["Analyse automatique indisponible : fusion humaine nécessaire."],
                "behavior_preserving": False, "fork_features_preserved": False,
                "no_security_or_data_change": False}


def monitor_ci(pr, base, head, verdict, reasons, root, state, deadline):
    number = pr["number"]
    while time.monotonic() < deadline:
        current = api(f"repos/{FORK}/pulls/{number}")
        if current["state"] != "open":
            state["status"] = "merged" if current.get("merged") else "declined"
            return state
        if current["head"]["sha"] != head or current["base"]["sha"] != base:
            state["status"] = "changed_during_checks"
            state["message"] = "La base ou la révision a changé ; nouvelle analyse au prochain passage."
            return state
        runs = api(f"repos/{FORK}/actions/workflows/ci.yml/runs?event=pull_request&head_sha={head}&per_page=50")["workflow_runs"]
        runs = [run for run in runs if any(p.get("number") == number for p in run.get("pull_requests", []))]
        if runs:
            run = max(runs, key=lambda value: value["id"])
            state["ci_url"] = run["html_url"]
            if run["status"] == "completed":
                jobs = api(f"repos/{FORK}/actions/runs/{run['id']}/jobs?per_page=100")["jobs"]
                if not successful_ci(run, jobs, number, head):
                    state["status"] = "ci_failed"
                    update_body(current, section(verdict, reasons, base, head, "CI échouée ou incomplète — examen requis", run["html_url"]))
                    return state
                # Revalidate both revisions and mergeability immediately before the guarded merge.
                current = api(f"repos/{FORK}/pulls/{number}")
                live_base = api(f"repos/{FORK}/commits/{quote(state['base_branch'], safe='')}")["sha"]
                if (current["head"]["sha"] != head or current["base"]["sha"] != base
                        or live_base != base or current.get("mergeable") is not True
                        or current.get("mergeable_state") != "clean" or current.get("draft") is True):
                    state["status"] = "merge_blocked"
                    update_body(current, section(verdict, reasons, base, head, "Fusion bloquée — réévaluation nécessaire", run["html_url"]))
                    return state
                update_body(current, section(verdict, reasons, base, head, "Lot simple, CI complète réussie", run["html_url"]))
                command(["gh", "pr", "merge", str(number), "--repo", FORK, "--merge", "--match-head-commit", head])
                merged = api(f"repos/{FORK}/pulls/{number}")
                if not merged.get("merged"):
                    raise RuntimeError("GitHub n'a pas confirmé la fusion.")
                state["status"] = "merged"
                state["merge_commit"] = merged["merge_commit_sha"]
                return state
        time.sleep(30)
    state["status"] = "waiting_ci"
    update_body(pr, section(verdict, reasons, base, head, "En attente d'une CI complète — aucun contournement", state.get("ci_url")))
    return state


def run(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (root / "run.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("Une veille est déjà en cours.")
        return
    repo = root / "repo"
    if not repo.exists():
        command(["git", "clone", "--no-checkout", f"https://github.com/{FORK}.git", repo], timeout=300)
        git(repo, "remote", "add", "upstream", f"https://github.com/{UPSTREAM}.git")
    if (git(repo, "remote", "get-url", "origin").stdout.strip() != f"https://github.com/{FORK}.git"
            or git(repo, "remote", "get-url", "upstream").stdout.strip() != f"https://github.com/{UPSTREAM}.git"):
        raise RuntimeError("Remotes inattendus : arrêt sans écriture distante.")
    base_branch = api(f"repos/{FORK}")["default_branch"]
    upstream_branch = api(f"repos/{UPSTREAM}")["default_branch"]
    git(repo, "fetch", "--no-tags", "origin", f"+refs/heads/{base_branch}:refs/remotes/origin/watch-base")
    git(repo, "fetch", "--no-tags", "upstream", f"+refs/heads/{upstream_branch}:refs/remotes/upstream/watch-head")
    base = git(repo, "rev-parse", "refs/remotes/origin/watch-base").stdout.strip()
    upstream = git(repo, "rev-parse", "refs/remotes/upstream/watch-head").stdout.strip()
    state = {"at": now(), "base": base, "upstream": upstream, "base_branch": base_branch}
    ancestor = git(repo, "merge-base", "--is-ancestor", upstream, base, check=False)
    if ancestor.returncode == 0:
        state["status"] = "up_to_date"
        save(root / "latest.json", state)
        print(json.dumps(state, ensure_ascii=False))
        return
    if ancestor.returncode != 1:
        raise RuntimeError("Impossible de comparer les historiques.")
    previous = json.loads((root / "latest.json").read_text()) if (root / "latest.json").exists() else {}
    prs = api(f"repos/{FORK}/pulls?state=all&head={quote('Yteria17:' + MIRROR, safe='')}&base={quote(base_branch, safe='')}&per_page=100")
    prs = [p for p in prs if p["head"].get("repo", {}).get("full_name") == FORK and p["head"]["ref"] == MIRROR]
    opened = next((p for p in prs if p["state"] == "open"), None)
    declined = next((p for p in prs if p["state"] == "closed" and not p.get("merged_at")), None)
    if not opened and declined and declined["head"]["sha"] == upstream:
        state.update(status="declined", pr_url=declined["html_url"])
        save(root / "latest.json", state)
        print(json.dumps(state, ensure_ascii=False))
        return
    same_pair = previous.get("base") == base and previous.get("upstream") == upstream
    if same_pair and opened and previous.get("pr_url") == opened["html_url"]:
        if previous.get("status") == "review" and previous.get("verdict", {}).get("analysis_complete") is True:
            print(json.dumps({**previous, "message": "Décision humaine déjà en attente ; aucun doublon."}, ensure_ascii=False))
            return
        if previous.get("verdict") and simple(previous["verdict"], previous.get("blockers", [])):
            state = monitor_ci(opened, base, upstream, previous["verdict"], previous.get("blockers", []), root, {**previous, "at": now()}, time.monotonic() + 1800)
            save(root / "latest.json", state)
            print(json.dumps(state, ensure_ascii=False))
            return
    logdir = root / "logs" / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    logdir.mkdir(parents=True, mode=0o700)
    checkout = Path(tempfile.mkdtemp(prefix="review-", dir=root))
    checkout.rmdir()
    try:
        git(repo, "worktree", "add", "--detach", checkout, base)
        merged = git(checkout, "merge", "--no-commit", "--no-ff", upstream, check=False)
        conflicts = git(checkout, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        if merged.returncode and not conflicts:
            conflicts = ["Échec de la tentative de fusion : " + merged.stderr[-500:]]
        files = git(repo, "diff", "--no-renames", "--name-only", f"{base}...{upstream}").stdout.splitlines()
        patch_bytes = len(git(repo, "diff", "--binary", f"{base}...{upstream}").stdout.encode())
        unresolved_decline = declined is not None and git(repo, "merge-base", "--is-ancestor", declined["head"]["sha"], base, check=False).returncode != 0
        reasons = blockers(files, conflicts, patch_bytes, unresolved_decline)
        verdict = review(checkout, root, base, upstream, reasons, logdir)
    finally:
        git(repo, "worktree", "remove", "--force", checkout, check=False)
        if checkout.exists():
            shutil.rmtree(checkout)
    state.update(verdict=verdict, blockers=reasons, log=str(logdir), status="review")
    # Mirror only on our fork, without tags and without force-pushing human edits.
    git(repo, "push", "--no-follow-tags", "origin", f"{upstream}:refs/heads/{MIRROR}")
    automatic = simple(verdict, reasons)
    body = section(verdict, reasons, base, upstream, "Lot simple — tests en cours" if automatic else "Décision humaine requise")
    if opened:
        update_body(opened, body)
        pr = api(f"repos/{FORK}/pulls/{opened['number']}")
    else:
        pr = api(f"repos/{FORK}/pulls", "POST", {"title": "[Amont] Revue des nouveautés LearnHarness", "head": MIRROR,
                  "base": base_branch, "body": body, "maintainer_can_modify": False})
    state.update(pr_url=pr["html_url"], pr_number=pr["number"], status="waiting_ci" if automatic else ("review" if verdict.get("analysis_complete") is True else "analysis_incomplete"))
    save(root / "latest.json", state)
    if automatic:
        state = monitor_ci(pr, base, upstream, verdict, reasons, root, state, time.monotonic() + 1800)
        save(root / "latest.json", state)
    save(logdir / "result.json", state)
    print(json.dumps(state, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.root.resolve())
    except Exception as error:
        failure = {"at": now(), "status": "failed", "message": str(error)}
        save(args.root / "failure.json", failure)
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
