#!/usr/bin/env python3
"""Reject JavaScript package installs that bypass Socket Firewall in CI."""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path


WORKFLOWS_DIRECTORY = Path(".github/workflows")
RUN_DIRECTIVE = re.compile(r"^(?P<indent>\s*)(?:-\s+)?run:\s*(?P<value>.*)$")
BLOCK_SCALAR = re.compile(r"^[|>][+-]?(?:\s+#.*)?$")
UNPROTECTED_INSTALL = re.compile(
    r"(?<![\w-])(?<!sfw\s)(?:pnpm|npm|yarn|bun)\b"
    r"(?=[^#\n;&|]*\b(?:install|i|ci|add)\b)"
    r"[^#\n;&|]*\b(?:install|i|ci|add)\b",
    re.IGNORECASE,
)


def indentation(line: str) -> int:
    return len(line) - len(line.lstrip())


def joined_commands(
    lines: list[tuple[int, str]], *, folded: bool
) -> Iterator[tuple[int, str]]:
    command = ""
    command_line = 0

    for line_number, raw_line in lines:
        line = raw_line.strip()
        if not line:
            if command:
                yield command_line, command
                command = ""
            continue

        if not command:
            command_line = line_number
        command = f"{command} {line}".strip()

        if folded:
            continue
        if command.endswith("\\"):
            command = command[:-1].rstrip()
            continue

        yield command_line, command
        command = ""

    if command:
        yield command_line, command


def workflow_commands(workflow_file: Path) -> Iterator[tuple[int, str]]:
    lines = workflow_file.read_text(encoding="utf-8").splitlines()
    index = 0

    while index < len(lines):
        match = RUN_DIRECTIVE.match(lines[index])
        if not match:
            index += 1
            continue

        value = match.group("value").strip()
        if not BLOCK_SCALAR.match(value):
            if value:
                yield index + 1, value
            index += 1
            continue

        block_indent = len(match.group("indent"))
        block_lines: list[tuple[int, str]] = []
        index += 1
        while index < len(lines):
            line = lines[index]
            if line.strip() and indentation(line) <= block_indent:
                break
            block_lines.append((index + 1, line))
            index += 1

        yield from joined_commands(block_lines, folded=value.startswith(">"))


def main() -> int:
    violations: list[tuple[Path, int, str]] = []

    workflow_files = sorted(WORKFLOWS_DIRECTORY.glob("*.yml"))
    workflow_files.extend(sorted(WORKFLOWS_DIRECTORY.glob("*.yaml")))

    for workflow_file in workflow_files:
        for line_number, command in workflow_commands(workflow_file):
            if UNPROTECTED_INSTALL.search(command):
                violations.append((workflow_file, line_number, command))

    if violations:
        for workflow_file, line_number, command in violations:
            print(
                f"::error file={workflow_file},line={line_number}::"
                "Package installation must run through Socket Firewall: "
                f"{command}"
            )
        return 1

    print("All CI package installations run through Socket Firewall.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
