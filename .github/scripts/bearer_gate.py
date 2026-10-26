#!/usr/bin/env python3
"""Decide whether a Bearer SARIF report blocks the pipeline.

Bearer only collects findings. The blocking policy lives here so it can be
tested and so Code Scanning only ever receives findings nobody has accepted:

* a finding of any severity, from the SAST or the secrets scanner, that is not
  listed in bearer.ignore blocks;
* an entry of bearer.ignore that no longer matches a finding blocks too, so a
  fix has to delete its exception in the same change and an exception can never
  silently cover the same code again;
* an entry without an author, a comment and a date blocks: every exception has
  to say who accepted it and why.

The report must come from a scan that ignored bearer.ignore, otherwise stale
entries could not be told apart from fixed ones. In `strict` mode the baseline
is not applied at all and every finding blocks, which is the way to measure the
debt that bearer.ignore currently hides.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


ENFORCE = "enforce"
STRICT = "strict"
FINGERPRINT_KEY = "primaryLocationLineHash"
REQUIRED_ENTRY_FIELDS = ("author", "comment", "ignored_at")
MAX_LISTED = 40
MAX_ANNOTATIONS = 10


@dataclass(frozen=True)
class Finding:
    rule: str
    path: str
    line: int
    message: str
    fingerprint: str

    def describe(self) -> str:
        return f"{self.rule} {self.path}:{self.line} ({self.fingerprint or 'no fingerprint'})"


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        sys.exit(f"Cannot read {path}: {error}")


def sarif_results(report: object) -> list[dict]:
    """The results of the single run Bearer writes; `null` means no findings."""
    runs = report.get("runs") if isinstance(report, dict) else None
    if not isinstance(runs, list) or len(runs) != 1 or not isinstance(runs[0], dict):
        sys.exit("The SARIF report must contain exactly one run.")
    return runs[0].get("results") or []


def to_finding(result: dict) -> Finding:
    location = (result.get("locations") or [{}])[0].get("physicalLocation", {})
    return Finding(
        rule=result.get("ruleId", "unknown"),
        path=location.get("artifactLocation", {}).get("uri", "unknown"),
        line=location.get("region", {}).get("startLine", 0),
        message=result.get("message", {}).get("text", ""),
        fingerprint=result.get("partialFingerprints", {}).get(FINGERPRINT_KEY, ""),
    )


def load_baseline(path: Path) -> dict[str, dict]:
    """bearer.ignore maps a fingerprint to who accepted it, when and why."""
    if not path.exists():
        return {}
    baseline = load_json(path)
    if not isinstance(baseline, dict) or not all(
        isinstance(entry, dict) for entry in baseline.values()
    ):
        sys.exit(f"{path} must map each fingerprint to an object.")
    return baseline


def incomplete_entries(baseline: dict[str, dict]) -> list[str]:
    return sorted(
        fingerprint
        for fingerprint, entry in baseline.items()
        if not all(str(entry.get(field, "")).strip() for field in REQUIRED_ENTRY_FIELDS)
    )


def escape_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def escape_property(value: str) -> str:
    return escape_data(value).replace(":", "%3A").replace(",", "%2C")


def annotation(finding: Finding) -> str:
    """A workflow command, with every value escaped: paths come from the change."""
    return (
        f"::error file={escape_property(finding.path)},line={finding.line},"
        f"title={escape_property('Bearer ' + finding.rule)}::"
        f"{escape_data(finding.message)} "
        f"To accept it, run: bearer ignore add {escape_data(finding.fingerprint)}"
    )


def listing(title: str, lines: list[str]) -> list[str]:
    if not lines:
        return []
    shown = lines[:MAX_LISTED]
    hidden = len(lines) - len(shown)
    block = [f"{title} ({len(lines)}):", *(f"  - {line}" for line in shown)]
    if hidden:
        block.append(f"  ... and {hidden} more")
    return block


def markdown(lines: list[str]) -> str:
    return "\n".join(lines) + "\n"


def evaluate(
    results: list[dict], baseline: dict[str, dict], mode: str
) -> tuple[list[dict], list[Finding], list[str], list[str]]:
    """Return the blocking results, the blocking findings, stale and incomplete entries."""
    pairs = [(result, to_finding(result)) for result in results]
    if mode == STRICT:
        blocking, stale, incomplete = pairs, [], []
    else:
        # A result without a fingerprint cannot be accepted, so it always blocks.
        blocking = [
            (result, finding)
            for result, finding in pairs
            if not finding.fingerprint or finding.fingerprint not in baseline
        ]
        found = {finding.fingerprint for _, finding in pairs}
        stale = sorted(fingerprint for fingerprint in baseline if fingerprint not in found)
        incomplete = incomplete_entries(baseline)
    return (
        [result for result, _ in blocking],
        [finding for _, finding in blocking],
        stale,
        incomplete,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sarif", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--blocking-sarif", type=Path, required=True)
    parser.add_argument("--mode", choices=(ENFORCE, STRICT), default=ENFORCE)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()

    report = load_json(args.sarif)
    results = sarif_results(report)
    baseline = load_baseline(args.baseline)
    blocking, findings, stale, incomplete = evaluate(results, baseline, args.mode)

    # Code Scanning only receives what blocks, so its alerts match the red check.
    # Bearer writes `null` for an empty list, which Code Scanning rejects.
    driver = report["runs"][0]["tool"]["driver"]
    driver["rules"] = driver.get("rules") or []
    report["runs"][0]["results"] = blocking
    args.blocking_sarif.write_text(json.dumps(report), encoding="utf-8")

    by_rule = Counter(finding.rule for finding in findings)
    lines = [
        f"### Bearer ({args.mode})",
        "",
        f"- findings in the scan: {len(results)}",
        f"- accepted in {args.baseline.name}: {len(results) - len(blocking)}",
        f"- blocking: {len(findings)}",
        f"- stale exceptions: {len(stale)}",
        f"- incomplete exceptions: {len(incomplete)}",
    ]
    if by_rule:
        lines += ["", "| Rule | Findings |", "| --- | --- |"]
        lines += [f"| `{rule}` | {count} |" for rule, count in by_rule.most_common()]

    details = [
        *listing("New findings", [finding.describe() for finding in findings]),
        *listing(
            f"Exceptions in {args.baseline.name} that match nothing any more: delete them",
            stale,
        ),
        *listing(
            f"Exceptions in {args.baseline.name} without author, comment and date",
            incomplete,
        ),
    ]
    print("\n".join(lines))
    if details:
        print()
        print("\n".join(details))
    for finding in findings[:MAX_ANNOTATIONS]:
        print(annotation(finding))

    if args.summary:
        with args.summary.open("a", encoding="utf-8") as summary:
            summary.write(markdown(lines))
            if details:
                summary.write("\n```\n" + markdown(details) + "```\n")

    return 1 if findings or stale or incomplete else 0


if __name__ == "__main__":
    sys.exit(main())
