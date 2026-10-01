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
import { authGateTiming } from "./auth_gate_exemptions.ts";
import { buildCommandTree } from "./mod.ts";

const tree = buildCommandTree();

function timing(args: string[]) {
  return authGateTiming(tree, args);
}

Deno.test("authGateTiming: bare swamp and the auth path are exempt", () => {
  for (
    const args of [
      [],
      ["--json"],
      ["--log"],
      ["auth"],
      ["auth", "login"],
      ["auth", "logout", "--json"],
      ["auth", "whoami"],
      ["--json", "auth", "whoami"],
      ["help"],
      ["help", "model"],
      ["help", "model", "method", "run"],
      ["--log", "help", "workflow"],
      // A pasted command line after `help` is still only help.
      ["help", "vault", "put", "prod", "DB_PASSWORD=hunter2"],
      ["completions", "zsh"],
      ["completions", "bash"],
      ["version"],
      ["version", "--json"],
      ["update"],
      ["--log", "update"],
    ]
  ) {
    assertEquals(timing(args), "exempt", args.join(" "));
  }
});

Deno.test("authGateTiming: help and version flags Cliffy answers are exempt", () => {
  for (
    const args of [
      ["--help"],
      ["-h"],
      ["--version"],
      ["-V"],
      ["model", "--help"],
      ["model", "method", "run", "-h"],
      ["--json", "serve", "--help"],
    ]
  ) {
    assertEquals(timing(args), "exempt", args.join(" "));
  }
});

Deno.test("authGateTiming: every other subcommand is gated", () => {
  for (
    const args of [
      ["telemetry", "disable"],
      ["serve"],
      ["worker", "exec-dispatch"],
      ["audit", "record", "--from-hook"],
      ["auth", "server-login"],
      ["auth", "token", "list"],
      ["model", "method", "run", "m", "go"],
      ["modle"],
      ["auth", "nonsense"],
    ]
  ) {
    assertEquals(timing(args), "gated", args.join(" "));
  }
});

Deno.test("authGateTiming: a boolean global option never hides the command after it", () => {
  // Regression: a positional guess once read `swamp --log init` as bare
  // `swamp`, because it did not know `--log` takes no value.
  for (
    const args of [
      ["--log", "init"],
      ["--log", "serve"],
      ["auth", "--log", "token", "list"],
      ["--show-properties", "doctor"],
    ]
  ) {
    assertEquals(timing(args), "gated", args.join(" "));
  }
});

Deno.test("authGateTiming: every top-level command behind every boolean root option is gated", () => {
  const booleanRootOptions = tree.getGlobalOptions(true)
    .concat(tree.getOptions(true))
    .filter((o) => (o.args ?? []).length === 0)
    .flatMap((o) => o.flags)
    .filter((flag) => !["--help", "-h", "--version", "-V"].includes(flag));
  const commands = tree.getCommands(true).map((c) => c.getName())
    // These hold exempt commands; their own tests cover them.
    .filter((name) =>
      !["auth", "help", "completions", "version", "update"].includes(name)
    );
  assertEquals(booleanRootOptions.includes("--log"), true);
  for (const option of booleanRootOptions) {
    for (const command of commands) {
      assertEquals(
        timing([option, command]),
        "gated",
        `${option} ${command}`,
      );
    }
  }
});

Deno.test("authGateTiming: a help token taken as an option's value does not exempt", () => {
  assertEquals(
    timing(["model", "method", "run", "m", "go", "--input", "--help"]),
    "gated",
  );
  assertEquals(
    timing(["--log-level", "--help", "serve"]),
    "gated",
  );
});

Deno.test("authGateTiming: a help token after -- is a literal argument", () => {
  assertEquals(
    timing(["model", "method", "run", "m", "go", "--", "--help"]),
    "gated",
  );
});

Deno.test("authGateTiming: a value that merely contains --help is not a flag", () => {
  assertEquals(
    timing(["model", "method", "run", "m", "go", "--input=--help"]),
    "gated",
  );
});
