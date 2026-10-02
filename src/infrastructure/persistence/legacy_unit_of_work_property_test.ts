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

// The legacy unit of work is a pure pass-through to the mark hook: datastore
// rework Phase 1 relies on it sending exactly the marks repositories send
// today, in the same order and with the same arguments.

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import fc from "fast-check";
import type { StagedChange } from "../../domain/datastore/unit_of_work.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";

const arbPath = fc
  .array(fc.constantFrom("data", "a", "b", "v1", "latest", "x.yaml"), {
    minLength: 1,
    maxLength: 4,
  })
  .map((segments) => "/cache/" + segments.join("/"));

const arbChange: fc.Arbitrary<StagedChange> = fc.oneof(
  arbPath.map((path): StagedChange => ({ kind: "write", path })),
  arbPath.map((path): StagedChange => ({ kind: "remove", path })),
  fc.constantFrom("rename tombstone", "gc").map((reason): StagedChange => ({
    kind: "bulk",
    reason,
  })),
);

/** The argument the mark hook receives for a change today. */
function directMark(change: StagedChange): string | undefined {
  return change.kind === "bulk" ? undefined : change.path;
}

Deno.test("createLegacyUnitOfWork: hook calls equal direct hook calls for any change sequence", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbChange, { maxLength: 30 }),
      async (changes) => {
        const direct: (string | undefined)[] = [];
        for (const change of changes) direct.push(directMark(change));

        const viaAdapter: (string | undefined)[] = [];
        const unit = createLegacyUnitOfWork((relPath?: string) => {
          viaAdapter.push(relPath);
          return Promise.resolve();
        });
        for (const change of changes) await unit.stage(change);

        assertEquals(viaAdapter, direct);
        assertEquals(unit.staged(), changes);
      },
    ),
  );
});

Deno.test("createLegacyUnitOfWork: a hook rejection stops staging at exactly that change", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbChange, { minLength: 1, maxLength: 30 }).chain((changes) =>
        fc.tuple(
          fc.constant(changes),
          fc.integer({ min: 0, max: changes.length - 1 }),
        )
      ),
      async ([changes, failAt]) => {
        const error = new Error("hook failed");
        const calls: (string | undefined)[] = [];
        const unit = createLegacyUnitOfWork((relPath?: string) => {
          calls.push(relPath);
          return calls.length - 1 === failAt
            ? Promise.reject(error)
            : Promise.resolve();
        });

        for (let i = 0; i < failAt; i++) await unit.stage(changes[i]);
        const rejected = await assertRejects(() => unit.stage(changes[failAt]));

        assertStrictEquals(rejected, error);
        assertEquals(calls, changes.slice(0, failAt + 1).map(directMark));
        assertEquals(unit.staged(), changes.slice(0, failAt + 1));
      },
    ),
  );
});
