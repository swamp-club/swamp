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

import { assertEquals, assertRejects } from "@std/assert";
import type { UnitOfWork } from "../domain/datastore/unit_of_work.ts";
import { createLegacyUnitOfWork } from "../infrastructure/persistence/legacy_unit_of_work.ts";
import { useUnitOfWorkFactoryForTesting } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { stageWritesThenPush } from "./stage_writes_then_push.ts";

/** A mark hook and push that record what they were called with, in order. */
function recording(options: { failMark?: string; failPush?: boolean } = {}) {
  const events: string[] = [];
  return {
    events,
    repoContext: {
      markDirty(path?: string) {
        if (path === options.failMark) {
          return Promise.reject(new Error("index unwritable"));
        }
        events.push(`mark ${path ?? "<bare>"}`);
        return Promise.resolve();
      },
    },
    push() {
      events.push("push");
      return options.failPush
        ? Promise.reject(new Error("datastore unreachable"))
        : Promise.resolve(0);
    },
  };
}

Deno.test("stageWritesThenPush: stages each path as a write, in order, through one root over the same hook, then pushes once", async () => {
  const { events, repoContext, push } = recording();
  const roots: { unit: UnitOfWork; hookMatches: boolean }[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    const unit = createLegacyUnitOfWork(markDirty, {
      flush: options.flush,
      parent: options.parent,
      afterCommit: "reject",
    });
    if (options.role === "root") {
      roots.push({ unit, hookMatches: markDirty === repoContext.markDirty });
    }
    return unit;
  });
  try {
    await stageWritesThenPush(repoContext, ["a", "b"], { flush: push });
  } finally {
    dispose();
  }

  assertEquals(roots.length, 1);
  assertEquals(roots[0].hookMatches, true);
  assertEquals(roots[0].unit.staged(), [
    { kind: "write", path: "a" },
    { kind: "write", path: "b" },
  ]);
  assertEquals(events, ["mark a", "mark b", "push"]);
});

Deno.test("stageWritesThenPush: a failed mark skips the push and throws the mark's error", async () => {
  const { events, repoContext, push } = recording({ failMark: "b" });

  await assertRejects(
    () => stageWritesThenPush(repoContext, ["a", "b", "c"], { flush: push }),
    Error,
    "index unwritable",
  );

  assertEquals(events, ["mark a"]);
});

Deno.test("stageWritesThenPush: a failed push is thrown after every mark", async () => {
  const { events, repoContext, push } = recording({ failPush: true });

  await assertRejects(
    () => stageWritesThenPush(repoContext, ["a"], { flush: push }),
    Error,
    "datastore unreachable",
  );

  assertEquals(events, ["mark a", "push"]);
});

Deno.test("stageWritesThenPush: with no paths it still pushes once", async () => {
  const { events, repoContext, push } = recording();

  await stageWritesThenPush(repoContext, [], { flush: push });

  assertEquals(events, ["push"]);
});

Deno.test("stageWritesThenPush: with no mark hook it stages nothing and still pushes", async () => {
  const { events, push } = recording();

  await stageWritesThenPush({ markDirty: undefined }, ["a"], { flush: push });

  assertEquals(events, ["push"]);
});
