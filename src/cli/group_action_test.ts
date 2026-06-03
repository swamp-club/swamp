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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { groupCommandAction } from "./group_action.ts";

Deno.test("groupCommandAction: emits JSON error when --json is in args", () => {
  const originalArgs = Deno.args;
  const originalLog = console.log;
  const originalExit = Deno.exit;
  let output = "";
  let exitCode: number | undefined;

  try {
    Object.defineProperty(Deno, "args", {
      value: ["--json"],
      configurable: true,
    });
    console.log = (...args: unknown[]) => {
      output += args.join(" ");
    };
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = (code: number) => {
      exitCode = code;
      throw new Error("EXIT");
    };

    const cmd = new Command()
      .name("test-group")
      .command("sub1", new Command().description("First subcommand"))
      .command("sub2", new Command().description("Second subcommand"));

    try {
      groupCommandAction.call(cmd);
    } catch (e) {
      if ((e as Error).message !== "EXIT") throw e;
    }
  } finally {
    Object.defineProperty(Deno, "args", {
      value: originalArgs,
      configurable: true,
    });
    console.log = originalLog;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = originalExit;
  }

  assertEquals(exitCode, 1);
  const parsed = JSON.parse(output);
  assertEquals(parsed.error, "No subcommand specified");
  assertEquals(parsed.availableCommands.sort(), ["sub1", "sub2"]);
});

Deno.test("groupCommandAction: calls showHelp when not in JSON mode", () => {
  const originalArgs = Deno.args;
  let helpShown = false;

  try {
    Object.defineProperty(Deno, "args", { value: [], configurable: true });

    const cmd = new Command()
      .name("test-group")
      .command("sub1", new Command().description("First subcommand"));

    // Override showHelp to track whether it was called
    cmd.showHelp = () => {
      helpShown = true;
    };

    groupCommandAction.call(cmd);
  } finally {
    Object.defineProperty(Deno, "args", {
      value: originalArgs,
      configurable: true,
    });
  }

  assertEquals(helpShown, true);
});

Deno.test("groupCommandAction: JSON output is valid parseable JSON", () => {
  const originalArgs = Deno.args;
  const originalLog = console.log;
  const originalExit = Deno.exit;
  let output = "";

  try {
    Object.defineProperty(Deno, "args", {
      value: ["--json"],
      configurable: true,
    });
    console.log = (...args: unknown[]) => {
      output += args.join(" ");
    };
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = () => {
      throw new Error("EXIT");
    };

    const cmd = new Command()
      .name("parent")
      .command("child", new Command().description("A child"));

    try {
      groupCommandAction.call(cmd);
    } catch (e) {
      if ((e as Error).message !== "EXIT") throw e;
    }
  } finally {
    Object.defineProperty(Deno, "args", {
      value: originalArgs,
      configurable: true,
    });
    console.log = originalLog;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = originalExit;
  }

  const parsed = JSON.parse(output);
  assertStringIncludes(parsed.error, "No subcommand");
  assertEquals(Array.isArray(parsed.availableCommands), true);
});
