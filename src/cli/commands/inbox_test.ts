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

import { Command } from "@cliffy/command";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  createInboxCommand,
  inboxCommand,
  inboxInteractiveApplies,
} from "./inbox.ts";

await initializeLogging({});

Deno.test("inboxInteractiveApplies: only in log mode with stdin and stdout on a terminal", () => {
  const cases: [OutputMode, boolean, boolean, boolean][] = [
    ["log", true, true, true],
    ["log", true, false, false],
    ["log", false, true, false],
    ["log", false, false, false],
    ["json", true, true, false],
    ["json", true, false, false],
    ["json", false, true, false],
    ["json", false, false, false],
  ];
  for (const [mode, stdinIsTty, stdoutIsTty, expected] of cases) {
    assertEquals(
      inboxInteractiveApplies(mode, stdinIsTty, stdoutIsTty),
      expected,
      `${mode} stdin=${stdinIsTty} stdout=${stdoutIsTty}`,
    );
  }
});

Deno.test("inbox read: takes an optional id and says it is never interactive", () => {
  const read = inboxCommand.getCommand("read");
  assert(read !== undefined);

  const args = read.getArguments();
  assertEquals(args.length, 1);
  assertEquals(args[0].name, "message_id");
  assertEquals(args[0].optional, true);
  assertStringIncludes(read.getDescription(), "Never interactive.");
  assertEquals(read.getExamples().map((e) => e.description), [
    "swamp inbox read",
    "swamp inbox read 01JBX5Q8ZK0000000000000104",
    "swamp inbox read --json",
  ]);
});

/**
 * Runs `args` through `swamp inbox` built over recording stubs, under a root
 * that carries `--json` as the real CLI does. Returns the calls made, in order.
 */
async function runInboxWith(
  args: string[],
  tty: { stdin: boolean; stdout: boolean },
): Promise<string[]> {
  const calls: string[] = [];
  const command = createInboxCommand({
    stdinIsTty: () => {
      calls.push("stdinIsTty");
      return tty.stdin;
    },
    stdoutIsTty: () => {
      calls.push("stdoutIsTty");
      return tty.stdout;
    },
    runInbox: (_logger, input) => {
      calls.push(`runInbox all=${input.all}`);
      return Promise.resolve();
    },
    listInbox: (_logger, outputMode, input) => {
      calls.push(`listInbox ${outputMode} all=${input.all}`);
      return Promise.resolve();
    },
    readInbox: (_logger, outputMode, messageId) => {
      calls.push(`readInbox ${outputMode} ${messageId ?? "next"}`);
      return Promise.resolve();
    },
  });
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("inbox", command);
  await withMockedEnv(
    { SWAMP_CLI_OUTPUT_JSON: undefined },
    () => root.parse(["inbox", ...args]),
  );
  return calls;
}

const TERMINAL = { stdin: true, stdout: true };
const NOT_BOTH_TERMINAL = [
  { stdin: false, stdout: true },
  { stdin: true, stdout: false },
];

Deno.test("inbox read: in a terminal it reads the next message and never opens the interactive inbox", async () => {
  assertEquals(await runInboxWith(["read"], TERMINAL), ["readInbox log next"]);
});

Deno.test("inbox read: passes the message id, and --json, to the read", async () => {
  const id = "01JBX5Q8ZK0000000000000104";
  assertEquals(await runInboxWith(["read", id], TERMINAL), [
    `readInbox log ${id}`,
  ]);
  assertEquals(await runInboxWith(["read", "--json"], TERMINAL), [
    "readInbox json next",
  ]);
});

Deno.test("inbox: opens the interactive inbox in log mode with stdin and stdout on a terminal", async () => {
  assertEquals(await runInboxWith(["--all"], TERMINAL), [
    "stdinIsTty",
    "stdoutIsTty",
    "runInbox all=true",
  ]);
});

Deno.test("inbox: lists instead with --json or without a terminal on both ends", async () => {
  assertEquals(await runInboxWith(["--json"], TERMINAL), [
    "stdinIsTty",
    "stdoutIsTty",
    "listInbox json all=false",
  ]);
  for (const tty of NOT_BOTH_TERMINAL) {
    assertEquals(
      (await runInboxWith([], tty)).at(-1),
      "listInbox log all=false",
      `stdin=${tty.stdin} stdout=${tty.stdout}`,
    );
  }
});

Deno.test("inbox: says it browses, and when it marks messages read", () => {
  assertEquals(
    inboxCommand.getDescription(),
    "Browse your Swamp Club inbox. In a terminal, an interactive inbox " +
      "where opening a message marks it read. Otherwise a list of messages " +
      "with their ids, which marks nothing read.",
  );
});
