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

/**
 * Log timestamp format regression tests (swamp-club#1157).
 *
 * Drives the real CLI and asserts that log lines carry an unambiguous
 * RFC3339 (ISO-8601 UTC, `Z`) timestamp followed by a bracketed level —
 * not the old bare-UTC `HH:MM:SS.mmm` prefix that had no timezone marker or
 * date. Also asserts the colored and `--no-color` paths share one layout.
 */

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertNotMatch,
} from "@std/assert";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-log-ts-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// A log line in the new format: RFC3339 UTC timestamp + bracketed level.
const NEW_FORMAT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+\[(TRC|DBG|INF|WRN|ERR|FTL)\]\s/m;

// The old, ambiguous format: bare UTC time, no date, no offset, bare level.
const OLD_FORMAT = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+(TRC|DBG|INF|WRN|ERR|FTL)\s/m;

// Any ANSI SGR escape sequence. The ESC byte is built via String.fromCharCode
// so the pattern carries no literal control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Runs a command that reliably emits log lines (a model method run at debug
 * level) and returns stdout+stderr combined.
 *
 * Passes an (empty) piped stdin so the child's stdin is not a TTY — this
 * deterministically selects the non-interactive console sink (the daemon /
 * piped scenario from the bug report) rather than the interactive pretty sink,
 * which would otherwise be chosen when the test runner's own stdin is a TTY.
 */
async function runWithLogs(dir: string, extraArgs: string[]): Promise<string> {
  const create = await runCliCommand(
    ["model", "create", "command/shell", "smoke"],
    dir,
    "",
  );
  assertEquals(create.code, 0, `model create failed: ${create.stderr}`);

  const run = await runCliCommand(
    [
      ...extraArgs,
      "--log-level",
      "debug",
      "model",
      "method",
      "run",
      "smoke",
      "execute",
      "--input",
      "run=echo hi",
    ],
    dir,
    "",
  );
  assertEquals(run.code, 0, `method run failed: ${run.stderr}`);
  return `${run.stdout}\n${run.stderr}`;
}

Deno.test("piped log lines use RFC3339, not the old bare-UTC format", async () => {
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    // Default invocation with output piped (non-TTY), as scripts and daemons
    // see it — the exact context from the bug report.
    const output = await runWithLogs(dir, []);

    assertMatch(output, NEW_FORMAT);
    assertNotMatch(output, OLD_FORMAT);

    // The log lines themselves must carry no ANSI escape codes (report tables
    // rendered via @std/fmt/colors may still be colored — that is a separate,
    // NO_COLOR-governed concern). Check a line that is unambiguously a log line.
    const logLine = output.split("\n").find((l) => NEW_FORMAT.test(l));
    assertExists(logLine, "expected at least one RFC3339 log line");
    assertNotMatch(logLine, ANSI);
  });
});

Deno.test("--no-color log lines use RFC3339, not the old bare-UTC format", async () => {
  await withTempDir(async (dir) => {
    await initializeTestRepo(dir);
    const output = await runWithLogs(dir, ["--no-color"]);

    assertMatch(output, NEW_FORMAT);
    assertNotMatch(output, OLD_FORMAT);
    assertNotMatch(output, ANSI);
  });
});
