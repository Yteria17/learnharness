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
MAX_DATA = 1024 * 1024 * 1024
MAX_FILE = 50 * 1024 * 1024
GRAPH = {"nodes.jsonl", "chains.jsonl", "sessions.jsonl", "coverage.jsonl",
         "sources.json", "positions.json", "render-settings.json", "format.json"}


def allowed(name):
    if not isinstance(name, str) or len(name) > 240:
        return False
    return (name == "settings.json"
            or re.fullmatch(r"attachments/[a-f0-9]{64}\.bin", name) is not None
            or re.fullmatch(r"documents/[a-f0-9]{64}\.json", name) is not None
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
            raise ValueError("Profile exceeds 1 GiB")
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
        if not isinstance(current, dict) or current.get("version") not in (1, 2):
            raise ValueError("Unsupported stored version")
        if request.get("version") == 2:
            return handle_v2(root, request, current)
        if current.get("version") == 2:
            raise ValueError("Update LearnHarness on this computer: this profile uses the document library")
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


def manifest_of(files):
    validate(files)
    return {name: {"hash": hashlib.sha256(base64.b64decode(value)).hexdigest(),
                   "size": len(base64.b64decode(value))} for name, value in sorted(files.items())}


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or len(manifest) > 20000:
        raise ValueError("Invalid manifest")
    total = 0
    for name, info in manifest.items():
        if (not allowed(name) or not isinstance(info, dict) or set(info) != {"hash", "size"}
                or not isinstance(info["hash"], str) or re.fullmatch(r"[a-f0-9]{64}", info["hash"]) is None
                or type(info["size"]) is not int or not 0 <= info["size"] <= MAX_FILE):
            raise ValueError("Invalid manifest entry")
        if name.startswith("attachments/") and name != "attachments/" + info["hash"] + ".bin":
            raise ValueError("Attachment integrity check failed")
        total += info["size"]
        if total > MAX_DATA:
            raise ValueError("Profile exceeds 1 GiB")
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_object(root, digest, data):
    objects = root / "objects"
    objects.mkdir(exist_ok=True, mode=0o700)
    target = objects / digest
    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError("Stored object failed integrity check")
        return
    fd, temp = tempfile.mkstemp(prefix=".pending-", dir=objects)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
        directory = os.open(objects, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def handle_v2(root, request, current):
    legacy = current.get("version") == 1
    if legacy:
        if current["revision"] is not None and validate(current["files"]) != current["revision"]:
            raise ValueError("Stored snapshot failed integrity check")
        manifest = manifest_of(current["files"])
        revision = validate_manifest(manifest) if current["revision"] is not None else None
    else:
        manifest, revision = current["manifest"], current["revision"]
        if validate_manifest(manifest) != revision:
            raise ValueError("Stored manifest failed integrity check")
    op = request.get("op")
    if op == "head":
        return {"ok": True, "version": 2, "revision": revision, "manifest": manifest}
    if op == "get":
        if request.get("revision") != revision:
            return {"ok": False, "error": "conflict"}
        names = request.get("names")
        if not isinstance(names, list) or len(names) > 20000 or len(set(names)) != len(names):
            raise ValueError("Invalid file selection")
        if any(name not in manifest for name in names) or sum(manifest[name]["size"] for name in names) > 64 * 1024 * 1024:
            raise ValueError("Invalid or oversized file selection")
        files = {}
        for name in names:
            data = base64.b64decode(current["files"][name]) if legacy else (root / "objects" / manifest[name]["hash"]).read_bytes()
            if len(data) != manifest[name]["size"] or hashlib.sha256(data).hexdigest() != manifest[name]["hash"]:
                raise ValueError("Stored object failed integrity check")
            files[name] = base64.b64encode(data).decode()
        return {"ok": True, "version": 2, "revision": revision, "files": files}
    if op == "objects":
        files = request.get("files")
        incoming = manifest_of(files)
        validate_manifest(incoming)
        if sum(info["size"] for info in incoming.values()) > 64 * 1024 * 1024:
            raise ValueError("Object batch too large")
        for name, info in incoming.items():
            write_object(root, info["hash"], base64.b64decode(files[name]))
        return {"ok": True}
    if op != "put":
        raise ValueError("Unknown operation")
    if "expected" not in request or request["expected"] != revision:
        return {"ok": False, "error": "conflict", "revision": revision}
    incoming = request.get("manifest")
    new_revision = validate_manifest(incoming)
    # Existing v1 bytes are materialized only when a v2 revision is committed.
    if legacy:
        for name, info in manifest.items():
            if name in incoming and incoming[name] == info:
                write_object(root, info["hash"], base64.b64decode(current["files"][name]))
    for info in incoming.values():
        target = root / "objects" / info["hash"]
        if not target.is_file() or target.stat().st_size != info["size"]:
            raise ValueError("Missing object; retry synchronization")
    snapshot = {"version": 2, "revision": new_revision, "manifest": incoming}
    history = root / "history"
    history.mkdir(exist_ok=True, mode=0o700)
    atomic_write(history / (new_revision + ".json"), snapshot)
    atomic_write(root / "head.json", snapshot)
    return {"ok": True, "revision": new_revision, "count": len(incoming)}


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
