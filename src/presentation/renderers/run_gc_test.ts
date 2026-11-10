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

import { assert, assertEquals } from "@std/assert";
import { configure, reset } from "@logtape/logtape";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { textFormatter } from "../../infrastructure/logging/log_format.ts";
import type {
  RunGcAutoDefinition,
  RunGcData,
} from "../../libswamp/data/run_gc.ts";
import { createRunGcRenderer, renderRunGcPreview } from "./run_gc.ts";

await initializeLogging({});

// the non-TTY formatter is the one that quotes interpolated strings
async function captureFormatted(fn: () => void): Promise<string[]> {
  const format = textFormatter();
  const lines: string[] = [];
  await configure({
    reset: true,
    sinks: {
      kept: (record) => {
        const text = format(record).replace(/\n$/, "");
        lines.push(text.slice(text.indexOf(": ") + 2));
      },
    },
    loggers: [
      { category: ["run", "gc"], sinks: ["kept"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  try {
    fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return lines;
}

function definitions(count: number): RunGcAutoDefinition[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `idle-${i + 1}`,
    type: "command/shell",
  }));
}

function data(
  autoDefinitions: RunGcAutoDefinition[],
  dryRun: boolean,
): RunGcData {
  return {
    workflowRunsDeleted: 0,
    workflowRunBytesReclaimed: 0,
    outputsDeleted: 0,
    outputBytesReclaimed: 0,
    evaluatedSnapshotsDeleted: 0,
    evaluatedSnapshotBytesReclaimed: 0,
    totalBytesReclaimed: 0,
    autoDefinitionsDeleted: autoDefinitions.length,
    autoDefinitions,
    dryRun,
  };
}

function renderCompleted(d: RunGcData): void {
  const handlers = createRunGcRenderer("log").handlers();
  handlers.completed({ kind: "completed", data: d });
}

Deno.test("createRunGcRenderer: log mode prints each removed auto-definition on its own unquoted line", async () => {
  const lines = await captureFormatted(() =>
    renderCompleted(data(definitions(2), false))
  );
  assertEquals(lines.slice(1), [
    "Run GC removed 2 idle auto-definition(s):",
    "  idle-1 (command/shell)",
    "  idle-2 (command/shell)",
  ]);
});

Deno.test("createRunGcRenderer: log dry run lists the auto-definitions it would remove, unquoted", async () => {
  const lines = await captureFormatted(() =>
    renderCompleted(data(definitions(1), true))
  );
  assertEquals(lines.slice(1), [
    "Run GC dry run: would remove 1 idle auto-definition(s):",
    "  idle-1 (command/shell)",
  ]);
});

Deno.test("createRunGcRenderer: log mode lists 20 auto-definitions and counts the rest", async () => {
  const lines = await captureFormatted(() =>
    renderCompleted(data(definitions(23), false))
  );
  const listed = lines.slice(2);
  assertEquals(listed.length, 21);
  assertEquals(listed[19], "  idle-20 (command/shell)");
  assertEquals(listed[20], "  and 3 more");
  assert(listed.every((line) => !line.includes('"')), listed.join("\n"));
});

Deno.test("renderRunGcPreview: log mode lists the auto-definitions to remove, unquoted", async () => {
  const lines = await captureFormatted(() =>
    renderRunGcPreview({
      workflowRunsToDelete: 0,
      workflowRunBytesReclaimable: 0,
      outputsToDelete: 0,
      outputBytesReclaimable: 0,
      evaluatedSnapshotsToDelete: 0,
      evaluatedSnapshotBytesReclaimable: 0,
      totalBytesReclaimable: 0,
      autoDefinitionsToDelete: 2,
      autoDefinitions: definitions(2),
    }, "log")
  );
  assertEquals(lines, [
    "Run GC preview: 2 idle auto-definition(s) to remove, with their edited arguments:",
    "  idle-1 (command/shell)",
    "  idle-2 (command/shell)",
  ]);
});

Deno.test("createRunGcRenderer: json mode keeps the auto-definitions as an array", () => {
  const original = console.log;
  const json: string[] = [];
  console.log = (...args: unknown[]) => json.push(args.join(" "));
  try {
    createRunGcRenderer("json").handlers().completed({
      kind: "completed",
      data: data(definitions(1), false),
    });
  } finally {
    console.log = original;
  }
  const parsed = JSON.parse(json.join("\n"));
  assertEquals(parsed.autoDefinitions, [
    { name: "idle-1", type: "command/shell" },
  ]);
  assertEquals(parsed.autoDefinitionsDeleted, 1);
});
