import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("watch", Path(__file__).with_name("run.py"))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.verdict = {"analysis_complete": True, "decision": "simple", "risks": [], "behavior_preserving": True,
                        "fork_features_preserved": True, "no_security_or_data_change": True}
        self.run = {"event": "pull_request", "head_sha": "abc", "status": "completed",
                    "conclusion": "success", "path": ".github/workflows/ci.yml",
                    "repository": {"full_name": watch.FORK}, "pull_requests": [{"number": 42}]}
        self.jobs = [{"name": name, "status": "completed", "conclusion": "success"}
                     for name in watch.REQUIRED_JOBS]

    def test_simple_requires_semantic_approval_and_all_positive_flags(self):
        self.assertTrue(watch.simple(self.verdict, []))
        for key in self.verdict:
            broken = dict(self.verdict)
            broken[key] = "review" if key == "decision" else False
            self.assertFalse(watch.simple(broken, []))
        self.assertFalse(watch.simple({"decision": "simple"}, []))
        self.assertFalse(watch.simple(self.verdict, ["conflict"]))

    def test_sensitive_paths_override_model(self):
        for name in ["electron/main.cjs", "scripts/sync/sync-data.mjs", ".github/workflows/ci.yml",
                     "package.json", "package-lock.json", "src/store/graph.ts", "AGENTS.md",
                     "components/update-banner.tsx", "ops/upstream-watch/run.py", "tests/safety.test.ts"]:
            reasons = watch.blockers([name], [], 100)
            self.assertTrue(reasons, name)
            self.assertFalse(watch.simple(self.verdict, reasons))
        self.assertEqual(watch.blockers(["README.md", "components/ui/button.tsx"], [], 100), [])

    def test_conflict_size_and_decline_block(self):
        for reasons in [watch.blockers([], ["file.ts"], 1), watch.blockers([], [], 200001),
                        watch.blockers([f"file{i}" for i in range(31)], [], 1),
                        watch.blockers([], [], 1, True)]:
            self.assertTrue(reasons)
            self.assertFalse(watch.simple(self.verdict, reasons))

    def test_ci_is_exact_fork_revision_pr_and_complete_matrix(self):
        self.assertTrue(watch.successful_ci(self.run, self.jobs, 42, "abc"))
        mutations = [{"event": "push"}, {"head_sha": "other"}, {"path": "other.yml"},
                     {"repository": {"full_name": watch.UPSTREAM}}, {"pull_requests": []},
                     {"status": "in_progress"}, {"conclusion": "skipped"}]
        for changes in mutations:
            self.assertFalse(watch.successful_ci({**self.run, **changes}, self.jobs, 42, "abc"))
        self.assertFalse(watch.successful_ci(self.run, self.jobs[:-1], 42, "abc"))
        for conclusion in ["failure", "skipped", "cancelled", "neutral"]:
            jobs = copy.deepcopy(self.jobs)
            jobs[0]["conclusion"] = conclusion
            self.assertFalse(watch.successful_ci(self.run, jobs, 42, "abc"))

    def test_pr_update_preserves_human_text(self):
        original = f"Human introduction\n{watch.START}\nold\n{watch.END}\nHuman conclusion"
        with patch.object(watch, "api") as api:
            watch.update_body({"number": 42, "body": original}, f"{watch.START}\nnew\n{watch.END}")
            body = api.call_args.args[2]["body"]
            self.assertIn("Human introduction", body)
            self.assertIn("Human conclusion", body)
            self.assertNotIn("old", body)

    def test_changed_base_never_reaches_merge(self):
        current = {"state": "open", "head": {"sha": "abc"}, "base": {"sha": "new-base"}}
        with patch.object(watch, "api", return_value=current), patch.object(watch, "command") as command:
            state = watch.monitor_ci({"number": 42}, "old-base", "abc", self.verdict, [],
                                     Path("/unused"), {}, float("inf"))
            self.assertEqual(state["status"], "changed_during_checks")
            command.assert_not_called()

    def test_failed_ci_does_not_merge(self):
        current = {"state": "open", "head": {"sha": "abc"}, "base": {"sha": "base"}, "number": 42}
        failed = {**self.run, "id": 1, "html_url": "https://github.com/run/1", "conclusion": "failure"}
        with patch.object(watch, "api", side_effect=[current, {"workflow_runs": [failed]}, {"jobs": self.jobs}]), \
             patch.object(watch, "update_body"), patch.object(watch, "command") as command:
            state = watch.monitor_ci({"number": 42}, "base", "abc", self.verdict, [],
                                     Path("/unused"), {}, float("inf"))
            self.assertEqual(state["status"], "ci_failed")
            command.assert_not_called()

    def test_success_uses_guarded_pr_merge_and_verifies_result(self):
        current = {"state": "open", "head": {"sha": "abc"}, "base": {"sha": "base"},
                   "number": 42, "mergeable": True, "mergeable_state": "clean", "draft": False}
        run = {**self.run, "id": 1, "html_url": "https://github.com/run/1"}
        responses = [current, {"workflow_runs": [run]}, {"jobs": self.jobs},
                     current, {"sha": "base"}, {"merged": True, "merge_commit_sha": "merged"}]
        with patch.object(watch, "api", side_effect=responses), patch.object(watch, "update_body"), \
             patch.object(watch, "command") as command:
            state = watch.monitor_ci({"number": 42}, "base", "abc", self.verdict, [],
                                     Path("/unused"), {"base_branch": "main"}, float("inf"))
            self.assertEqual(state["status"], "merged")
            command.assert_called_once_with(["gh", "pr", "merge", "42", "--repo", watch.FORK,
                                             "--merge", "--match-head-commit", "abc"])

    def test_base_changed_after_ci_is_still_blocked(self):
        current = {"state": "open", "head": {"sha": "abc"}, "base": {"sha": "base"},
                   "number": 42, "mergeable": True, "mergeable_state": "clean", "draft": False}
        run = {**self.run, "id": 1, "html_url": "https://github.com/run/1"}
        responses = [current, {"workflow_runs": [run]}, {"jobs": self.jobs}, current, {"sha": "new-base"}]
        with patch.object(watch, "api", side_effect=responses), patch.object(watch, "update_body"), \
             patch.object(watch, "command") as command:
            state = watch.monitor_ci({"number": 42}, "base", "abc", self.verdict, [],
                                     Path("/unused"), {"base_branch": "main"}, float("inf"))
            self.assertEqual(state["status"], "merge_blocked")
            command.assert_not_called()

if __name__ == "__main__":
    unittest.main()
