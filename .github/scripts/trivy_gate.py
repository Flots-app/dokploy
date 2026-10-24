#!/usr/bin/env python3
"""Decide whether a Trivy JSON report blocks the pipeline.

Trivy itself only collects findings (see trivy.yaml). The blocking policy lives
here so it can be tested and so the full report still reaches Code Scanning:

* secrets: always blocking;
* CRITICAL vulnerabilities with a fix, and CRITICAL misconfigurations: always
  blocking (dated exceptions live in .trivyignore.yaml);
* HIGH vulnerabilities with a fix and HIGH misconfigurations: a change may not
  add new ones compared with its base branch (`regression` mode with --base),
  or none may exist at all (`strict` mode).

Without --base, `regression` mode reports HIGH findings but does not block on
them.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


SECRET = "secret"
VULNERABILITY = "vulnerability"
MISCONFIGURATION = "misconfiguration"
MAX_LISTED = 40


@dataclass(frozen=True)
class Finding:
    kind: str
    severity: str
    target: str
    identifier: str
    package: str = ""
    installed: str = ""
    fixed: str = ""
    title: str = ""
    line: int = 0

    @property
    def key(self) -> tuple[str, str, str, str, str]:
        """Identity used to compare a report with its base report."""
        return (self.kind, self.target, self.identifier, self.package, self.installed)

    @property
    def fixable(self) -> bool:
        return self.kind != VULNERABILITY or bool(self.fixed)

    def describe(self) -> str:
        if self.kind == VULNERABILITY:
            upgrade = f" -> {self.fixed}" if self.fixed else ""
            return (
                f"{self.identifier} {self.package}@{self.installed}{upgrade} "
                f"({self.target})"
            )
        if self.kind == SECRET:
            return f"{self.identifier} {self.target}:{self.line}"
        return f"{self.identifier} {self.target}: {self.title}"


def load_findings(report: dict) -> list[Finding]:
    findings: list[Finding] = []
    for result in report.get("Results") or []:
        target = result.get("Target", "")
        for item in result.get("Vulnerabilities") or []:
            findings.append(
                Finding(
                    kind=VULNERABILITY,
                    severity=item.get("Severity", "UNKNOWN"),
                    target=target,
                    identifier=item.get("VulnerabilityID", ""),
                    package=item.get("PkgName", ""),
                    installed=item.get("InstalledVersion", ""),
                    fixed=item.get("FixedVersion", "") or "",
                    title=item.get("Title", ""),
                )
            )
        for item in result.get("Misconfigurations") or []:
            if item.get("Status", "FAIL") != "FAIL":
                continue
            findings.append(
                Finding(
                    kind=MISCONFIGURATION,
                    severity=item.get("Severity", "UNKNOWN"),
                    target=target,
                    identifier=item.get("ID", ""),
                    title=item.get("Title", ""),
                )
            )
        for item in result.get("Secrets") or []:
            findings.append(
                Finding(
                    kind=SECRET,
                    severity=item.get("Severity", "UNKNOWN"),
                    target=target,
                    identifier=item.get("RuleID", ""),
                    title=item.get("Title", ""),
                    line=item.get("StartLine", 0),
                )
            )
    return findings


def added_findings(head: list[Finding], base: list[Finding]) -> list[Finding]:
    """Findings present in head more often than in base, per identity."""
    remaining = Counter(finding.key for finding in base)
    added: list[Finding] = []
    for finding in head:
        if remaining[finding.key] > 0:
            remaining[finding.key] -= 1
        else:
            added.append(finding)
    return added


@dataclass
class Verdict:
    blocking: list[tuple[str, Finding]]
    reported: list[Finding]

    @property
    def passed(self) -> bool:
        return not self.blocking


def evaluate(
    head: list[Finding], base: list[Finding] | None, mode: str
) -> Verdict:
    blocking: list[tuple[str, Finding]] = []
    reported: list[Finding] = []

    for finding in head:
        if finding.kind == SECRET:
            blocking.append(("secret", finding))
        elif finding.severity == "CRITICAL" and finding.fixable:
            blocking.append(("critical", finding))

    high = [
        finding
        for finding in head
        if finding.severity == "HIGH" and finding.kind != SECRET and finding.fixable
    ]
    if mode == "strict":
        blocking.extend(("high", finding) for finding in high)
    elif base is None:
        reported.extend(high)
    else:
        base_high = [
            finding
            for finding in base
            if finding.severity == "HIGH"
            and finding.kind != SECRET
            and finding.fixable
        ]
        new_high = added_findings(high, base_high)
        blocking.extend(("new-high", finding) for finding in new_high)
        new_keys = Counter(finding.key for finding in new_high)
        for finding in high:
            if new_keys[finding.key] > 0:
                new_keys[finding.key] -= 1
            else:
                reported.append(finding)

    return Verdict(blocking=blocking, reported=reported)


REASONS = {
    "secret": "Secret detected",
    "critical": "CRITICAL finding with a fix available",
    "high": "HIGH finding (strict mode)",
    "new-high": "New HIGH finding compared with the base branch",
}


def escape_markdown(text: str) -> str:
    return text.replace("|", "\\|").replace("`", "'").replace("\n", " ")


def escape_annotation(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def render_summary(
    label: str,
    head: list[Finding],
    verdict: Verdict,
    mode: str,
    compared: bool,
) -> str:
    counts: Counter[tuple[str, str]] = Counter(
        (finding.kind, finding.severity) for finding in head
    )
    lines = [
        f"### Trivy: {label}",
        "",
        f"Policy: `{mode}`" + (", compared with the base branch" if compared else ""),
        "",
        "| Kind | CRITICAL | HIGH |",
        "| --- | ---: | ---: |",
    ]
    for kind in (VULNERABILITY, MISCONFIGURATION, SECRET):
        lines.append(
            f"| {kind} | {counts[(kind, 'CRITICAL')]} | {counts[(kind, 'HIGH')]} |"
        )
    lines.append("")

    if verdict.blocking:
        lines.append(f"**Blocking: {len(verdict.blocking)}**")
        lines.append("")
        for reason, finding in verdict.blocking[:MAX_LISTED]:
            lines.append(
                f"- {REASONS[reason]}: `{escape_markdown(finding.describe())}`"
            )
        if len(verdict.blocking) > MAX_LISTED:
            lines.append(f"- ... and {len(verdict.blocking) - MAX_LISTED} more")
    else:
        lines.append("**No blocking findings.**")

    if verdict.reported:
        lines.append("")
        lines.append(
            f"{len(verdict.reported)} existing HIGH findings are reported in "
            "Code Scanning but do not block."
        )
    lines.append("")
    return "\n".join(lines)


def read_report(path: Path) -> list[Finding]:
    return load_findings(json.loads(path.read_text(encoding="utf-8")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--head", type=Path, required=True, help="Trivy JSON report")
    parser.add_argument("--base", type=Path, help="Trivy JSON report of the base")
    parser.add_argument("--mode", choices=("regression", "strict"), default="regression")
    parser.add_argument("--label", default="scan")
    parser.add_argument("--summary", type=Path, help="File to append Markdown to")
    args = parser.parse_args(argv)

    head = read_report(args.head)
    base = read_report(args.base) if args.base else None
    verdict = evaluate(head, base, args.mode)
    summary = render_summary(args.label, head, verdict, args.mode, base is not None)

    print(summary)
    if args.summary:
        with args.summary.open("a", encoding="utf-8") as handle:
            handle.write(summary + "\n")

    for reason, finding in verdict.blocking:
        location = f",file={finding.target}" if finding.kind != VULNERABILITY else ""
        if finding.kind == SECRET and finding.line:
            location += f",line={finding.line}"
        print(
            f"::error title=Trivy {args.label}{location}::"
            f"{escape_annotation(REASONS[reason] + ': ' + finding.describe())}"
        )

    return 0 if verdict.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
