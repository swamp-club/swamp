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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { OutputMode } from "../../presentation/output/output.ts";
import { inboxCommand, inboxPickerApplies } from "./inbox.ts";

Deno.test("inboxPickerApplies: only in log mode with stdin and stdout on a terminal", () => {
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
      inboxPickerApplies(mode, stdinIsTty, stdoutIsTty),
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

Deno.test("inbox read: its action never opens the interactive inbox", async () => {
  // In a terminal the read command must print inline, as it does when piped,
  // so its action never consults the terminal check or starts the inbox.
  const source = await Deno.readTextFile(
    new URL("./inbox.ts", import.meta.url),
  );
  const start = source.indexOf("const inboxReadCommand");
  const end = source.indexOf("export const inboxCommand");
  assert(start !== -1 && end > start);
  const readCommand = source.slice(start, end);

  assert(!readCommand.includes("inboxPickerApplies"));
  assert(!readCommand.includes("runInbox("));
  assert(!readCommand.includes("isStdoutTty"));
});

Deno.test("inbox: says it browses, and when it marks messages read", () => {
  assertEquals(
    inboxCommand.getDescription(),
    "Browse your Swamp Club inbox. In a terminal, an interactive inbox " +
      "where opening a message marks it read. Otherwise a list of messages " +
      "with their ids, which marks nothing read.",
  );
});
