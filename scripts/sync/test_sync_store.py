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
        for name in ["../auth.json", "auth.json", "graph/../../x", "chats/a/../b.json", "jobs/x.json", "chatgpt-credentials.enc.json"]:
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


if __name__ == "__main__":
    unittest.main()
