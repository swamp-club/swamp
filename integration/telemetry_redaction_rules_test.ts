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

// Architectural fitness test: telemetry redaction over the real command tree
// (swamp-club#2817).
//
// Every command in the tree is invoked with a unique canary in each positional
// and option value, and the resolved telemetry invocation is checked:
//
// 1. Every command word is recorded, and `subcommand` is only ever a command
//    word — never a positional such as a path.
// 2. Canaries for sent arguments (names, ids, queries, types) appear; canaries
//    for redacted arguments (paths, values, the `data query` predicate) and for
//    every option value, known or mistyped, do not.
// 3. Every declared argument name is classified. A new argument name fails
//    here until it is added to SENT_ARGUMENTS or REDACTED_ARGUMENTS.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { registerCommands } from "../src/cli/mod.ts";
import {
  COMMAND_WORD_ARGUMENTS,
  isSentArgument,
  REDACTED_ARGUMENTS,
  resolveTelemetryInvocation,
  SENT_ARGUMENTS,
} from "../src/cli/telemetry_invocation.ts";

/** The root as runCli configures it, minus invocation state. */
function buildRoot(): AnyCommand {
  const root = new Command()
    .name("swamp")
    .globalOption("--json", "json")
    .globalOption("--log", "log")
    .globalOption("--log-level <level:string>", "level")
    .globalOption("-q, --quiet", "quiet")
    .globalOption("-v, --verbose", "verbose")
    .globalOption("--no-telemetry", "telemetry")
    .globalOption("--show-properties", "properties")
    .globalOption("--no-color", "color");
  registerCommands(root);
  return root;
}

interface CommandCase {
  path: string[];
  command: AnyCommand;
}

/** Every command that can take positionals, or that has no children. */
function collectCases(
  command: AnyCommand,
  path: string[],
  out: CommandCase[],
): CommandCase[] {
  const children = command.getCommands(true);
  if (
    path.length > 0 &&
    (children.length === 0 || command.getArguments().length > 0)
  ) {
    out.push({ path, command });
  }
  for (const child of children) {
    collectCases(child, [...path, child.getName()], out);
  }
  return out;
}

const CASES = collectCases(buildRoot(), [], []);

Deno.test("telemetry redaction: the tree has commands to check", () => {
  assert(CASES.length > 100, `only ${CASES.length} commands found`);
});

Deno.test("telemetry redaction: every declared argument name is classified", () => {
  const unclassified = new Set<string>();
  for (const { command } of CASES) {
    for (const argument of command.getArguments()) {
      if (
        argument.name !== "key" &&
        !SENT_ARGUMENTS.has(argument.name) &&
        !REDACTED_ARGUMENTS.has(argument.name) &&
        !COMMAND_WORD_ARGUMENTS.has(argument.name)
      ) {
        unclassified.add(argument.name);
      }
    }
  }
  assertEquals(
    [...unclassified].sort(),
    [],
    "classify these in src/cli/telemetry_invocation.ts",
  );
});

Deno.test("telemetry redaction: every command resolves to its full path", () => {
  const root = buildRoot();
  for (const { path } of CASES) {
    const result = resolveTelemetryInvocation(root, path);
    assertEquals(result.commandPath, path, path.join(" "));
    assertEquals(result.command, path[0]);
    assertEquals(result.subcommand, path[1]);
  }
});

Deno.test("telemetry redaction: only sent arguments survive, and no option value does", () => {
  const root = buildRoot();
  let counter = 0;
  const canary = () => `rdx-${counter++}-${crypto.randomUUID().slice(0, 8)}`;

  for (const { path, command } of CASES) {
    const expectSent: string[] = [];
    const expectRedacted: string[] = [];
    const args = [...path];

    for (const option of command.getOptions(true)) {
      if (option.global || (option.args ?? []).length === 0) continue;
      const value = canary();
      expectRedacted.push(value);
      args.push(`--${option.name}`, value);
    }
    const mistyped = canary();
    expectRedacted.push(mistyped);
    // `=` form: a mistyped option that swallows a separate token makes every
    // positional untrusted, which the unit tests cover.
    args.push(`--rdx-mistyped-option=${mistyped}`);

    const declared = command.getArguments();
    for (const argument of declared) {
      const values = argument.variadic ? [canary(), canary()] : [canary()];
      for (const value of values) {
        (isSentArgument(argument.name, path) ? expectSent : expectRedacted)
          .push(value);
        args.push(value);
      }
    }

    const payload = JSON.stringify(resolveTelemetryInvocation(root, args));
    for (const value of expectRedacted) {
      assert(
        !payload.includes(value),
        `${path.join(" ")}: ${value} leaked in ${payload}`,
      );
    }
    for (const value of expectSent) {
      assert(
        payload.includes(value),
        `${path.join(" ")}: ${value} missing from ${payload}`,
      );
    }
  }
});

Deno.test("telemetry redaction: leaving out a required argument sends nothing", () => {
  const root = buildRoot();
  for (const { path, command } of CASES) {
    const required = command.getArguments().filter((a) => !a.optional);
    if (required.length < 2) continue;
    // Drop the first required argument, so every value lands one slot early.
    const values = required.slice(1).map((_, i) =>
      `rdx-short-${i}-${crypto.randomUUID().slice(0, 8)}`
    );
    const payload = JSON.stringify(
      resolveTelemetryInvocation(root, [...path, ...values]),
    );
    for (const value of values) {
      assert(
        !payload.includes(value),
        `${path.join(" ")}: ${value} leaked in ${payload}`,
      );
    }
  }
});

Deno.test("telemetry redaction: help sends the command words it names and nothing after", () => {
  const root = buildRoot();
  for (const { path } of CASES) {
    if (path[0] === "help") continue;
    const secret = `rdx-help-${crypto.randomUUID().slice(0, 8)}`;
    const result = resolveTelemetryInvocation(root, ["help", ...path, secret]);
    assertEquals(result.commandPath, ["help"]);
    assertEquals(result.args, [...path, "<REDACTED>"], path.join(" "));
  }
});
