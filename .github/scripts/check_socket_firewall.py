#!/usr/bin/env python3
"""Reject JavaScript package installs that bypass Socket Firewall in CI."""

from __future__ import annotations

import re
from pathlib import Path


WORKFLOWS_DIRECTORY = Path(".github/workflows")
UNPROTECTED_INSTALL = re.compile(
    r"(?<![\w-])(?<!sfw\s)(?:pnpm|npm|yarn|bun)\b"
    r"(?=[^#\n;&|]*\b(?:install|i|ci|add)\b)"
    r"[^#\n;&|]*\b(?:install|i|ci|add)\b",
    re.IGNORECASE,
)


def main() -> int:
    violations: list[tuple[Path, int, str]] = []

    workflow_files = sorted(WORKFLOWS_DIRECTORY.glob("*.yml"))
    workflow_files.extend(sorted(WORKFLOWS_DIRECTORY.glob("*.yaml")))

    for workflow_file in workflow_files:
        for line_number, line in enumerate(
            workflow_file.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if UNPROTECTED_INSTALL.search(line):
                violations.append((workflow_file, line_number, line.strip()))

    if violations:
        for workflow_file, line_number, line in violations:
            print(
                f"::error file={workflow_file},line={line_number}::"
                f"Package installation must run through Socket Firewall: {line}"
            )
        return 1

    print("All CI package installations run through Socket Firewall.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
