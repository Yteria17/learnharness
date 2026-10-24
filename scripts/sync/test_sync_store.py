import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync_store", Path(__file__).with_name("sync-store.py"))
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, **fields):
        return store.handle(self.root, {"version": 1, **fields})

    def test_concurrent_uploads_cannot_overwrite_each_other(self):
        def upload(n):
            return self.request(op="put", expected=None, files={f"chats/chat_{n}.json": "e30="})
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(upload, [1, 2]))
        self.assertEqual(sum(r["ok"] for r in results), 1)
        self.assertEqual(len(self.request(op="get")["files"]), 1)

    def test_previous_revisions_survive_replacement(self):
        first = self.request(op="put", expected=None, files={"settings.json": "e30="})
        second = self.request(op="put", expected=first["revision"], files={})
        self.assertTrue(second["ok"])
        self.assertEqual(len(list((self.root / "history").glob("*.json"))), 2)

    def test_malformed_paths_and_credentials_are_rejected(self):
        for name in ["../auth.json", "auth.json", "graph/../../x", "chats/a/../b.json", "jobs/x.json", "chatgpt-credentials.enc.json", "chatgpt-credentials.json"]:
            with self.assertRaises(ValueError):
                self.request(op="put", expected=None, files={name: "e30="})
        self.assertIsNone(self.request(op="get")["revision"])

    def test_missing_lease_cannot_replace_an_empty_server(self):
        result = self.request(op="put", files={})
        self.assertEqual(result["error"], "conflict")

    def test_failed_head_commit_keeps_previous_head(self):
        first = self.request(op="put", expected=None, files={"settings.json": "e30="})
        original = store.atomic_write
        def fail_head(path, value):
            if path.name == "head.json":
                raise OSError("simulated disk failure")
            original(path, value)
        with patch.object(store, "atomic_write", fail_head):
            with self.assertRaises(OSError):
                self.request(op="put", expected=first["revision"], files={})
        self.assertEqual(self.request(op="get")["revision"], first["revision"])

    def v2(self, **fields):
        return store.handle(self.root, {"version": 2, **fields})

    def test_v2_migrates_legacy_history_without_changing_old_versions(self):
        first = self.request(op="put", expected=None, files={"settings.json": "e30="})
        old_history = (self.root / "history" / (first["revision"] + ".json")).read_bytes()
        head = self.v2(op="head")
        downloaded = self.v2(op="get", revision=head["revision"], names=["settings.json"])
        self.assertEqual(downloaded["files"], {"settings.json": "e30="})
        self.assertTrue(self.v2(op="put", expected=head["revision"], manifest=head["manifest"])["ok"])
        self.assertEqual((self.root / "history" / (first["revision"] + ".json")).read_bytes(), old_history)
        with self.assertRaisesRegex(ValueError, "Update LearnHarness"):
            self.request(op="put", expected=first["revision"], files={})

    def test_v2_objects_are_deduplicated_and_missing_objects_cannot_commit(self):
        files = {"chats/a.json": "e30=", "chats/b.json": "e30="}
        manifest = store.manifest_of(files)
        with self.assertRaisesRegex(ValueError, "Missing object"):
            self.v2(op="put", expected=None, manifest=manifest)
        self.assertIsNone(self.v2(op="head")["revision"])
        self.v2(op="objects", files=files)
        self.assertEqual(len(list((self.root / "objects").iterdir())), 1)
        self.assertTrue(self.v2(op="put", expected=None, manifest=manifest)["ok"])

    def test_v2_stale_commit_and_stale_download_do_not_replace_data(self):
        self.v2(op="objects", files={"settings.json": "e30="})
        first = self.v2(op="put", expected=None, manifest=store.manifest_of({"settings.json": "e30="}))
        self.assertFalse(self.v2(op="put", expected=None, manifest={})["ok"])
        self.assertFalse(self.v2(op="get", revision="old", names=["settings.json"])["ok"])
        self.assertEqual(self.v2(op="head")["revision"], first["revision"])

    def test_v2_rejects_unsafe_names_bad_hashes_and_oversized_files(self):
        for manifest in [
            {"auth.json": {"hash": "a" * 64, "size": 1}},
            {"settings.json": {"hash": "../head.json", "size": 1}},
            {"attachments/" + "a" * 64 + ".bin": {"hash": "b" * 64, "size": 1}},
            {"settings.json": {"hash": "a" * 64, "size": store.MAX_FILE + 1}},
            {"settings.json": {"hash": "a" * 64, "size": True}},
        ]:
            with self.assertRaises(ValueError):
                self.v2(op="put", expected=None, manifest=manifest)

    def test_v2_histories_keep_manifests_and_share_immutable_bytes(self):
        self.v2(op="objects", files={"settings.json": "e30="})
        first = self.v2(op="put", expected=None, manifest=store.manifest_of({"settings.json": "e30="}))
        self.v2(op="put", expected=first["revision"], manifest={})
        import json
        histories = [json.loads(file.read_text()) for file in (self.root / "history").glob("*.json")]
        self.assertTrue(all("manifest" in item and "files" not in item for item in histories))
        self.assertEqual(len(list((self.root / "objects").iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
