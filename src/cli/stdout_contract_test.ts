// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { assertEquals } from "@std/assert";
import { isValueOnlyStdoutCommand } from "./stdout_contract.ts";
import { extractCommandInfo } from "./telemetry_integration.ts";

Deno.test("isValueOnlyStdoutCommand: only the listed commands claim stdout", () => {
  assertEquals(
    isValueOnlyStdoutCommand({ command: "invite", subcommand: "link" }),
    true,
  );
  assertEquals(isValueOnlyStdoutCommand({ command: "first-rule" }), true);
  assertEquals(
    isValueOnlyStdoutCommand({ command: "vault", subcommand: "read-secret" }),
    true,
  );

  // The groups themselves print help, which is prose.
  assertEquals(isValueOnlyStdoutCommand({ command: "invite" }), false);
  assertEquals(isValueOnlyStdoutCommand({ command: "vault" }), false);

  // A sibling subcommand of a listed group must not inherit the contract.
  assertEquals(
    isValueOnlyStdoutCommand({ command: "vault", subcommand: "list" }),
    false,
  );

  // `swamp version` prints its line through the logger to stdout, and must
  // keep doing so — this is the case that rules out flipping the default.
  assertEquals(isValueOnlyStdoutCommand({ command: "version" }), false);
  assertEquals(
    isValueOnlyStdoutCommand({ command: "model", subcommand: "list" }),
    false,
  );
});

Deno.test("isValueOnlyStdoutCommand: holds across the argv forms callers actually type", () => {
  // Driven through extractCommandInfo rather than hand-built objects, because
  // that is how runCli reaches this predicate. The two were reasoned about
  // separately once, and a parser bug on `--log-level=debug invite link`
  // silently disabled the whole fix while every hand-written case passed.
  const valueOnly = [
    ["invite", "link"],
    ["invite", "link", "-v"],
    ["invite", "-v", "link"],
    ["-q", "invite", "link"],
    ["--log-level", "debug", "invite", "link"],
    ["--log-level=debug", "invite", "link"],
    ["--repo-dir=/tmp/x", "invite", "link"],
    ["--repo-dir", "/tmp/x", "invite", "link"],
    ["first-rule"],
    ["first-rule", "-v"],
    ["--log-level=debug", "first-rule"],
    ["vault", "read-secret", "myvault", "mykey"],
    ["--log-level=debug", "vault", "read-secret", "myvault", "mykey"],
  ];

  for (const args of valueOnly) {
    assertEquals(
      isValueOnlyStdoutCommand(extractCommandInfo(args)),
      true,
      `expected value-on-stdout: ${JSON.stringify(args)}`,
    );
  }

  const prose = [
    ["version"],
    ["-v", "version"],
    ["invite"],
    ["vault", "list"],
    ["--log-level=debug", "vault", "list"],
    ["model", "method", "run", "greeter", "greet"],
  ];

  for (const args of prose) {
    assertEquals(
      isValueOnlyStdoutCommand(extractCommandInfo(args)),
      false,
      `expected prose stdout: ${JSON.stringify(args)}`,
    );
  }
});
