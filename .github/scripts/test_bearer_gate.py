#!/usr/bin/env python3
"""Tests for the Bearer gate."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import bearer_gate


ENTRY = {"author": "alice", "comment": "reviewed", "ignored_at": "2026-10-24T00:00:00Z"}


def result(fingerprint: str, rule: str = "javascript_lang_path_traversal", path: str = "a.ts") -> dict:
    return {
        "ruleId": rule,
        "message": {"text": "Unsanitized user input"},
        "locations": [
            {
                "physicalLocation": {
                    "artifactLocation": {"uri": path},
                    "region": {"startLine": 12},
                }
            }
        ],
        "partialFingerprints": {bearer_gate.FINGERPRINT_KEY: fingerprint},
    }


def report(results: list[dict] | None) -> dict:
    return {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "Bearer"}}, "results": results}]}


class GateFixture(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def run_gate(
        self,
        results: list[dict] | None,
        baseline: dict | None = None,
        mode: str = bearer_gate.ENFORCE,
    ) -> tuple[int, str, dict]:
        sarif = self.directory / "all.sarif"
        blocking = self.directory / "blocking.sarif"
        ignore = self.directory / "bearer.ignore"
        sarif.write_text(json.dumps(report(results)), encoding="utf-8")
        if baseline is not None:
            ignore.write_text(json.dumps(baseline), encoding="utf-8")

        argv = [
            "bearer_gate.py",
            "--sarif", str(sarif),
            "--baseline", str(ignore),
            "--blocking-sarif", str(blocking),
            "--mode", mode,
        ]
        output = io.StringIO()
        with mock.patch("sys.argv", argv), contextlib.redirect_stdout(output):
            status = bearer_gate.main()
        return status, output.getvalue(), json.loads(blocking.read_text(encoding="utf-8"))


class BearerGateTests(GateFixture):
    def test_passes_without_findings(self) -> None:
        status, _, blocking = self.run_gate(None)
        self.assertEqual(status, 0)
        self.assertEqual(blocking["runs"][0]["results"], [])
        self.assertEqual(blocking["runs"][0]["tool"]["driver"]["rules"], [])

    def test_accepts_a_finding_listed_in_the_baseline(self) -> None:
        status, _, blocking = self.run_gate([result("aaa_0")], {"aaa_0": ENTRY})
        self.assertEqual(status, 0)
        self.assertEqual(blocking["runs"][0]["results"], [])

    def test_blocks_a_new_finding_and_keeps_only_it_for_code_scanning(self) -> None:
        status, output, blocking = self.run_gate(
            [result("aaa_0"), result("bbb_0", path="b.ts")], {"aaa_0": ENTRY}
        )
        self.assertEqual(status, 1)
        self.assertEqual([r["partialFingerprints"][bearer_gate.FINGERPRINT_KEY] for r in blocking["runs"][0]["results"]], ["bbb_0"])
        self.assertIn("bearer ignore add bbb_0", output)
        self.assertIn("::error file=b.ts,line=12,title=Bearer javascript_lang_path_traversal::", output)

    def test_blocks_a_finding_without_fingerprint(self) -> None:
        status, _, _ = self.run_gate([result("")], {"": ENTRY})
        self.assertEqual(status, 1)

    def test_blocks_a_stale_exception(self) -> None:
        status, output, _ = self.run_gate([], {"gone_0": ENTRY})
        self.assertEqual(status, 1)
        self.assertIn("gone_0", output)

    def test_blocks_an_exception_without_a_comment(self) -> None:
        status, output, _ = self.run_gate(
            [result("aaa_0")], {"aaa_0": {**ENTRY, "comment": "  "}}
        )
        self.assertEqual(status, 1)
        self.assertIn("without author, comment and date", output)

    def test_blocks_an_exception_without_an_author(self) -> None:
        entry = {key: value for key, value in ENTRY.items() if key != "author"}
        status, _, _ = self.run_gate([result("aaa_0")], {"aaa_0": entry})
        self.assertEqual(status, 1)

    def test_strict_mode_ignores_the_baseline(self) -> None:
        status, _, blocking = self.run_gate(
            [result("aaa_0")], {"aaa_0": ENTRY}, bearer_gate.STRICT
        )
        self.assertEqual(status, 1)
        self.assertEqual(len(blocking["runs"][0]["results"]), 1)

    def test_a_missing_baseline_means_nothing_is_accepted(self) -> None:
        status, _, _ = self.run_gate([result("aaa_0")])
        self.assertEqual(status, 1)

    def test_rejects_a_report_that_is_not_a_single_run(self) -> None:
        sarif = self.directory / "all.sarif"
        sarif.write_text(json.dumps({"runs": []}), encoding="utf-8")
        argv = [
            "bearer_gate.py",
            "--sarif", str(sarif),
            "--baseline", str(self.directory / "bearer.ignore"),
            "--blocking-sarif", str(self.directory / "blocking.sarif"),
        ]
        with mock.patch("sys.argv", argv), self.assertRaises(SystemExit) as raised:
            bearer_gate.main()
        self.assertIn("exactly one run", str(raised.exception))

    def test_rejects_an_unreadable_report(self) -> None:
        with self.assertRaises(SystemExit):
            bearer_gate.load_json(self.directory / "missing.sarif")

    def test_rejects_a_baseline_that_is_not_a_map_of_objects(self) -> None:
        ignore = self.directory / "bearer.ignore"
        ignore.write_text(json.dumps({"aaa_0": "ok"}), encoding="utf-8")
        with self.assertRaises(SystemExit):
            bearer_gate.load_baseline(ignore)


class AnnotationTests(unittest.TestCase):
    def test_escapes_what_a_change_controls(self) -> None:
        finding = bearer_gate.Finding(
            rule="rule",
            path="dir/a,b:c\n::error::forged.ts",
            line=3,
            message="100%\nmessage",
            fingerprint="aaa_0",
        )
        command = bearer_gate.annotation(finding)
        self.assertNotIn("\n", command)
        self.assertIn("file=dir/a%2Cb%3Ac%0A%3A%3Aerror%3A%3Aforged.ts,line=3", command)
        self.assertIn("100%25%0Amessage", command)


if __name__ == "__main__":
    unittest.main()
