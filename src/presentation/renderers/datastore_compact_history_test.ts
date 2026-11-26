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

import { assertEquals, assertThrows } from "@std/assert";
import { configure, reset } from "@logtape/logtape";
import type { DatastoreCompactHistoryData } from "../../libswamp/datastores/compact_history.ts";
import { UserError } from "../../domain/errors.ts";
import { createDatastoreCompactHistoryRenderer } from "./datastore_compact_history.ts";

function capture(fn: () => void): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return output.join("\n");
}

const CASES: DatastoreCompactHistoryData[] = [
  { applies: false },
  {
    applies: true,
    outcome: "compacted",
    compacted: 600,
    batches: 3,
    released: 4,
    partitions: 2,
    compactedThrough: 600,
  },
  {
    applies: true,
    outcome: "timed_out",
    budgetMs: 60_000,
    compacted: 250,
    batches: 1,
    released: 0,
    partitions: 1,
    compactedThrough: 250,
  },
  {
    applies: true,
    outcome: "not_due",
    eligibleCommits: 120,
    minCommits: 500,
    retainCommits: 2500,
  },
];

Deno.test("datastoreCompactHistoryRenderer json: prints each outcome as its data", () => {
  for (const data of CASES) {
    const output = capture(() =>
      createDatastoreCompactHistoryRenderer("json").handlers().completed({
        kind: "completed",
        data,
      })
    );
    assertEquals(JSON.parse(output), data);
  }
});

Deno.test("datastoreCompactHistoryRenderer log: says what each outcome means, without printing to stdout", async () => {
  const messages: string[] = [];
  await configure({
    reset: true,
    sinks: {
      kept: (record) => {
        messages.push(record.message.map((part) => String(part)).join(""));
      },
    },
    loggers: [
      { category: ["datastore"], sinks: ["kept"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  let output: string;
  try {
    const handlers = createDatastoreCompactHistoryRenderer("log").handlers();
    output = capture(() => {
      for (const data of CASES) handlers.completed({ kind: "completed", data });
    });
  } finally {
    await reset();
  }
  assertEquals(output, "");
  assertEquals(messages, [
    "Nothing to compact: history compaction applies only to v3 datastores",
    "Compacted 600 commits of 2 partitions in 3 batches; the compaction point is now 600",
    "Released 4 chunks for the next swamp datastore gc",
    "Stopped after the 60000 ms budget: compacted 250 commits of 1 partitions in 1 batches, kept; the compaction point is now 250. Run it again to fold the rest",
    "Nothing to compact: 120 commits can be folded, fewer than the 500 a compaction needs; the newest 2500 commits are always kept",
  ]);
});

Deno.test("datastoreCompactHistoryRenderer: an error event is a user error in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createDatastoreCompactHistoryRenderer(mode).handlers().error({
          kind: "error",
          error: { code: "maintenance_busy", message: "busy" },
        }),
      UserError,
      "busy",
    );
  }
});
