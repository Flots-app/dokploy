#!/usr/bin/env python3
"""Tests for the Socket Firewall workflow guard."""

from __future__ import annotations

import unittest

from check_socket_firewall import UNPROTECTED_INSTALL, workflow_commands


class WorkflowFixture:
    def __init__(self, contents: str) -> None:
        self.contents = contents

    def read_text(self, *, encoding: str) -> str:
        if encoding != "utf-8":
            raise ValueError("Workflow fixtures must be read as UTF-8")
        return self.contents


def violations(contents: str) -> list[tuple[int, str]]:
    workflow = WorkflowFixture(contents)
    return [
        (line_number, command)
        for line_number, command in workflow_commands(workflow)  # type: ignore[arg-type]
        if UNPROTECTED_INSTALL.search(command)
    ]


class SocketFirewallGuardTests(unittest.TestCase):
    def test_accepts_explicit_sfw_prefix(self) -> None:
        workflow = "      - run: sfw pnpm install --frozen-lockfile"
        self.assertEqual(violations(workflow), [])

    def test_rejects_inline_install(self) -> None:
        workflow = "      - run: npm ci"
        self.assertEqual(violations(workflow), [(1, "npm ci")])

    def test_rejects_literal_block_with_shell_continuations(self) -> None:
        workflow = "\n".join(
            [
                "      - run: |",
                "          pnpm \\",
                "            --filter app \\",
                "            install",
            ]
        )
        self.assertEqual(
            violations(workflow), [(2, "pnpm --filter app install")]
        )

    def test_rejects_folded_yaml_command(self) -> None:
        workflow = "\n".join(
            [
                "      - run: >",
                "          yarn",
                "          install --immutable",
            ]
        )
        self.assertEqual(
            violations(workflow), [(2, "yarn install --immutable")]
        )

    def test_rejects_unprotected_command_after_protected_command(self) -> None:
        workflow = "      - run: sfw pnpm install && pnpm add lodash"
        self.assertEqual(
            violations(workflow),
            [(1, "sfw pnpm install && pnpm add lodash")],
        )


if __name__ == "__main__":
    unittest.main()
