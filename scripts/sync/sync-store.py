#!/usr/bin/env python3
"""Private snapshot store, invoked over SSH. No daemon or listening port.

Protocol: one JSON request on stdin, one JSON response on stdout.
Snapshots use compare-and-swap; every accepted revision is retained.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

MAX_WIRE = 96 * 1024 * 1024
MAX_DATA = 64 * 1024 * 1024
GRAPH = {"nodes.jsonl", "chains.jsonl", "sessions.jsonl", "coverage.jsonl",
         "sources.json", "positions.json", "render-settings.json", "format.json"}


def allowed(name):
    if not isinstance(name, str) or len(name) > 240:
        return False
    return (name == "settings.json"
            or re.fullmatch(r"chats/[A-Za-z0-9_-]+\.json", name) is not None
            or (name.startswith("graph/") and name[6:] in GRAPH)
            or re.fullmatch(r"prompts/(?:[a-z][a-z0-9_-]*/)?[A-Za-z0-9_-]+\.md", name) is not None)


def validate(files):
    if not isinstance(files, dict) or len(files) > 20000:
        raise ValueError("Invalid file map")
    total = 0
    for name, value in files.items():
        if not allowed(name) or not isinstance(value, str):
            raise ValueError("Unsupported file path or content")
        data = base64.b64decode(value, validate=True)
        if base64.b64encode(data).decode() != value:
            raise ValueError("Noncanonical base64")
        total += len(data)
        if total > MAX_DATA:
            raise ValueError("Snapshot exceeds 64 MiB")
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def atomic_write(path, value):
    fd, temp = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def handle(root, request):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        head = root / "head.json"
        current = json.loads(head.read_text()) if head.exists() else {"version": 1, "revision": None, "files": {}}
        if not isinstance(current, dict) or current.get("version") != 1:
            raise ValueError("Unsupported stored version")
        if current["revision"] is not None and validate(current["files"]) != current["revision"]:
            raise ValueError("Stored snapshot failed integrity check")
        if not isinstance(request, dict) or request.get("version") != 1:
            raise ValueError("Unsupported request version")
        if request.get("op") == "get":
            return {"ok": True, **current}
        if request.get("op") == "head":
            return {"ok": True, "version": 1, "revision": current["revision"]}
        if request.get("op") != "put":
            raise ValueError("Unknown operation")
        if "expected" not in request or request["expected"] != current["revision"]:
            return {"ok": False, "error": "conflict", "revision": current["revision"]}
        revision = validate(request.get("files"))
        snapshot = {"version": 1, "revision": revision, "files": request["files"]}
        history = root / "history"
        history.mkdir(exist_ok=True, mode=0o700)
        atomic_write(history / (revision + ".json"), snapshot)
        atomic_write(head, snapshot)
        return {"ok": True, "revision": revision, "count": len(snapshot["files"])}


def main():
    os.umask(0o077)
    root = Path.home() / ".local/share/learnharness-sync/state"
    try:
        raw = sys.stdin.buffer.read(MAX_WIRE + 1)
        if len(raw) > MAX_WIRE:
            raise ValueError("Request too large")
        request = json.loads(raw)
        # Isolated profiles support end-to-end checks without touching the
        # user's default data. SSH authorization remains the same account.
        profile = request.get("profile")
        if profile is not None:
            if not isinstance(profile, str) or re.fullmatch(r"[a-z0-9-]{1,64}", profile) is None:
                raise ValueError("Invalid profile")
            root = root.parent / "profiles" / profile
        result = handle(root, request)
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
