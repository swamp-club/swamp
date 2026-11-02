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
import fc from "fast-check";
import {
  appendRunIndexLines,
  compactRunIndex,
  readRunIndex,
  type WorkflowRunIndexEntry,
  writeRunIndex,
} from "./workflow_run_index.ts";

type Op =
  | { kind: "put"; id: string; status: string }
  | { kind: "remove"; id: string }
  | { kind: "compact" };

const id = fc.constantFrom("a", "b", "c", "d", "__proto__", "run-é");
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("put" as const),
    id,
    status: fc.constantFrom("running", "succeeded", "failed"),
  }),
  fc.record({ kind: fc.constant("remove" as const), id }),
  fc.constant({ kind: "compact" as const }),
);

function entryOf(status: string): WorkflowRunIndexEntry {
  return {
    status,
    workflowId: "wf",
    workflowName: "w",
    tags: {},
    inputs: { note: "é".repeat(3) },
  };
}

Deno.test("run index: appends, removals and compactions read back as a map of the last change per run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        await writeRunIndex(dir, {});
        const model = new Map<string, WorkflowRunIndexEntry>();
        for (const next of ops) {
          if (next.kind === "compact") {
            await compactRunIndex(dir);
          } else if (next.kind === "put") {
            const entry = entryOf(next.status);
            model.set(next.id, entry);
            await appendRunIndexLines(dir, [{ id: next.id, entry }], {
              create: false,
            });
          } else {
            model.delete(next.id);
            await appendRunIndexLines(dir, [{ id: next.id, removed: true }], {
              create: false,
            });
          }
        }
        const read = await readRunIndex(dir);
        assertEquals(read?.damaged, undefined);
        assertEquals(
          new Map(Object.entries(read?.entries ?? {})),
          model,
        );
      }),
      { numRuns: 60 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
