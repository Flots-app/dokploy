#!/usr/bin/env python3
"""Tests for the Trivy blocking policy."""

from __future__ import annotations

import unittest

from trivy_gate import (
    MISCONFIGURATION,
    SECRET,
    VULNERABILITY,
    Finding,
    added_findings,
    evaluate,
    load_findings,
    render_summary,
)


def vulnerability(
    identifier: str = "CVE-1",
    severity: str = "HIGH",
    package: str = "left-pad",
    installed: str = "1.0.0",
    fixed: str = "1.0.1",
    target: str = "pnpm-lock.yaml",
) -> Finding:
    return Finding(
        kind=VULNERABILITY,
        severity=severity,
        target=target,
        identifier=identifier,
        package=package,
        installed=installed,
        fixed=fixed,
    )


def misconfiguration(
    identifier: str = "DS-0002", severity: str = "HIGH", target: str = "Dockerfile"
) -> Finding:
    return Finding(
        kind=MISCONFIGURATION, severity=severity, target=target, identifier=identifier
    )


def secret(target: str = "src/key.ts") -> Finding:
    return Finding(
        kind=SECRET, severity="HIGH", target=target, identifier="private-key", line=3
    )


def reasons(findings: list[Finding], base: list[Finding] | None, mode: str) -> list[str]:
    return [reason for reason, _ in evaluate(findings, base, mode).blocking]


class LoadFindingsTests(unittest.TestCase):
    def test_reads_every_scanner_and_tolerates_a_clean_report(self) -> None:
        self.assertEqual(load_findings({}), [])
        self.assertEqual(load_findings({"Results": [{"Target": "x"}]}), [])

        report = {
            "Results": [
                {
                    "Target": "pnpm-lock.yaml",
                    "Vulnerabilities": [
                        {
                            "VulnerabilityID": "CVE-1",
                            "Severity": "CRITICAL",
                            "PkgName": "a",
                            "InstalledVersion": "1",
                            "FixedVersion": "2",
                        }
                    ],
                },
                {
                    "Target": "Dockerfile",
                    "Misconfigurations": [
                        {"ID": "DS-0002", "Severity": "HIGH", "Status": "FAIL"},
                        {"ID": "DS-0001", "Severity": "HIGH", "Status": "PASS"},
                    ],
                },
                {
                    "Target": "src/key.ts",
                    "Secrets": [
                        {"RuleID": "private-key", "Severity": "HIGH", "StartLine": 7}
                    ],
                },
            ]
        }
        kinds = [finding.kind for finding in load_findings(report)]
        self.assertEqual(kinds, [VULNERABILITY, MISCONFIGURATION, SECRET])


class AlwaysBlockingTests(unittest.TestCase):
    def test_secrets_block_in_every_mode_even_on_a_base_that_has_them(self) -> None:
        for mode in ("regression", "strict"):
            self.assertEqual(reasons([secret()], [secret()], mode), ["secret"])
            self.assertEqual(reasons([secret()], None, mode), ["secret"])

    def test_critical_with_a_fix_blocks_even_if_the_base_has_it(self) -> None:
        critical = vulnerability(severity="CRITICAL")
        self.assertEqual(reasons([critical], [critical], "regression"), ["critical"])
        self.assertEqual(reasons([critical], None, "regression"), ["critical"])

    def test_critical_without_a_fix_does_not_block(self) -> None:
        unfixed = vulnerability(severity="CRITICAL", fixed="")
        self.assertEqual(reasons([unfixed], None, "strict"), [])

    def test_critical_misconfiguration_blocks(self) -> None:
        self.assertEqual(
            reasons([misconfiguration(severity="CRITICAL")], None, "regression"),
            ["critical"],
        )


class RegressionTests(unittest.TestCase):
    def test_existing_high_findings_do_not_block(self) -> None:
        existing = [vulnerability(), misconfiguration()]
        verdict = evaluate(existing, list(existing), "regression")
        self.assertTrue(verdict.passed)
        self.assertEqual(len(verdict.reported), 2)

    def test_a_new_high_vulnerability_blocks(self) -> None:
        base = [vulnerability("CVE-1")]
        head = [vulnerability("CVE-1"), vulnerability("CVE-2")]
        verdict = evaluate(head, base, "regression")
        self.assertEqual([f.identifier for _, f in verdict.blocking], ["CVE-2"])
        self.assertEqual([f.identifier for f in verdict.reported], ["CVE-1"])

    def test_upgrading_a_package_to_another_vulnerable_version_blocks(self) -> None:
        base = [vulnerability(installed="1.0.0")]
        head = [vulnerability(installed="1.0.5")]
        self.assertEqual(reasons(head, base, "regression"), ["new-high"])

    def test_a_second_occurrence_of_the_same_misconfiguration_blocks(self) -> None:
        base = [misconfiguration()]
        head = [misconfiguration(), misconfiguration()]
        self.assertEqual(reasons(head, base, "regression"), ["new-high"])

    def test_fixing_findings_passes(self) -> None:
        base = [vulnerability("CVE-1"), vulnerability("CVE-2")]
        self.assertEqual(reasons([vulnerability("CVE-1")], base, "regression"), [])

    def test_a_vulnerability_that_only_just_got_a_fix_does_not_count_as_new(self) -> None:
        base = [vulnerability(fixed="")]
        head = [vulnerability(fixed="")]
        self.assertEqual(reasons(head, base, "regression"), [])

    def test_without_a_base_high_findings_are_reported_only(self) -> None:
        verdict = evaluate([vulnerability()], None, "regression")
        self.assertTrue(verdict.passed)
        self.assertEqual(len(verdict.reported), 1)


class StrictTests(unittest.TestCase):
    def test_every_fixable_high_finding_blocks(self) -> None:
        head = [vulnerability(), misconfiguration()]
        self.assertEqual(reasons(head, list(head), "strict"), ["high", "high"])

    def test_unfixed_high_vulnerabilities_do_not_block(self) -> None:
        self.assertEqual(reasons([vulnerability(fixed="")], None, "strict"), [])


class AddedFindingsTests(unittest.TestCase):
    def test_counts_duplicates_instead_of_collapsing_them(self) -> None:
        finding = vulnerability()
        self.assertEqual(added_findings([finding, finding], [finding]), [finding])
        self.assertEqual(added_findings([finding], [finding, finding]), [])


class SummaryTests(unittest.TestCase):
    def test_summary_lists_blocking_findings_and_escapes_markdown(self) -> None:
        head = [vulnerability(identifier="CVE-9", package="a|b", severity="CRITICAL")]
        verdict = evaluate(head, None, "regression")
        summary = render_summary("repository", head, verdict, "regression", False)
        self.assertIn("Blocking: 1", summary)
        self.assertIn("CVE-9", summary)
        self.assertIn("a\\|b", summary)

    def test_clean_summary(self) -> None:
        verdict = evaluate([], None, "regression")
        summary = render_summary("repository", [], verdict, "regression", True)
        self.assertIn("No blocking findings.", summary)
        self.assertIn("compared with the base branch", summary)


if __name__ == "__main__":
    unittest.main()
