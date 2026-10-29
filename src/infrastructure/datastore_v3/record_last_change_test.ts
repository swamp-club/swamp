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
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitChange,
  CommitsCompactedError,
} from "../../domain/datastore_v3/commit_store.ts";
import {
  dataKey,
  modelCommit,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { recordLastChange } from "./record_last_change.ts";

/** A commit store over `commits`, or one whose history is compacted. */
function storeOf(commits: readonly Commit[], compacted = false) {
  return {
    head: () =>
      Promise.resolve({ seq: commits.length, highestFence: undefined }),
    readPartition: (): Promise<readonly CommitChange[]> =>
      compacted
        ? Promise.reject(new CommitsCompactedError(5, "read"))
        : Promise.resolve(
          commits.map((commit, i) => ({ cursor: i + 1, commit })),
        ),
  };
}

Deno.test("recordLastChange: names the newest commit that touched the key, its principal before its host", async () => {
  const commits = [
    modelCommit(1, [await savePut("a", 1)], { principal: "alice" }),
    modelCommit(2, [await savePut("a", 1, "x")], {
      principal: "bob",
      at: "2026-10-29T10:00:00.000Z",
    }),
    modelCommit(3, [await savePut("b", 1)], { principal: "carol" }),
  ];
  assertEquals(
    await recordLastChange(
      storeOf(commits),
      "",
      modelPartition(),
      dataKey("a", 1).toString(),
    ),
    { seq: 3, changedBy: "bob", changedAt: "2026-10-29T10:00:00.000Z" },
  );
  const unsigned = modelCommit(1, [await savePut("a", 1)]);
  const byHost = await recordLastChange(
    storeOf([unsigned]),
    "",
    modelPartition(),
    dataKey("a", 1).toString(),
  );
  assertEquals(byHost.changedBy, unsigned.writer.host);
});

Deno.test("recordLastChange: a key no recent commit touched, or compacted history, gives only the head", async () => {
  const commits = [modelCommit(1, [await savePut("b", 1)])];
  assertEquals(
    await recordLastChange(
      storeOf(commits),
      "",
      modelPartition(),
      dataKey("a", 1).toString(),
    ),
    { seq: 1 },
  );
  assertEquals(
    await recordLastChange(
      storeOf(commits, true),
      "",
      modelPartition(),
      dataKey("a", 1).toString(),
    ),
    { seq: 1 },
  );
});
