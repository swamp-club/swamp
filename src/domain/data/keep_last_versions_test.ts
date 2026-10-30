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
import { RESTATES_TAG } from "./data.ts";
import {
  isRestatement,
  versionsBeyondKeep,
  versionsBeyondKeepSync,
} from "./keep_last_versions.ts";

const restated = (set: number[]) => (version: number) => set.includes(version);

Deno.test("isRestatement: only the reserved restates tag marks one", () => {
  assertEquals(isRestatement({ [RESTATES_TAG]: "3", type: "resource" }), true);
  assertEquals(isRestatement({ type: "resource", restates: "3" }), false);
  assertEquals(isRestatement(undefined), false);
});

Deno.test("versionsBeyondKeepSync: without restatements keeps the newest N", () => {
  assertEquals(versionsBeyondKeepSync([1, 2, 3, 4, 5], 2, restated([])), [
    1,
    2,
    3,
  ]);
  assertEquals(versionsBeyondKeepSync([3, 1, 2], 5, restated([])), []);
});

Deno.test("versionsBeyondKeepSync: restatements above the cut do not count toward N", () => {
  // v2 is the rebased offline write; v3 restates v1 to keep it latest.
  assertEquals(versionsBeyondKeepSync([1, 2, 3], 1, restated([3])), [1]);
  assertEquals(
    versionsBeyondKeepSync([1, 2, 3, 4, 5, 6], 2, restated([3, 5, 6])),
    [1],
  );
});

Deno.test("versionsBeyondKeepSync: restatements below the N-th observation are removed", () => {
  assertEquals(versionsBeyondKeepSync([1, 2, 3, 4], 1, restated([2])), [
    1,
    2,
    3,
  ]);
});

Deno.test("versionsBeyondKeepSync: the highest version is kept when N is at least 1", () => {
  assertEquals(versionsBeyondKeepSync([1, 2, 3], 1, restated([1, 2, 3])), []);
  assertEquals(versionsBeyondKeepSync([1, 2], 0, restated([])), [1, 2]);
});

Deno.test("versionsBeyondKeep: asks only about versions above the cut", async () => {
  const asked: number[] = [];
  const removed = await versionsBeyondKeep(
    [1, 2, 3, 4, 5, 6, 7, 8],
    2,
    (version) => {
      asked.push(version);
      return Promise.resolve(version === 7);
    },
  );
  assertEquals(removed, [1, 2, 3, 4, 5]);
  assertEquals(asked, [8, 7, 6]);
});
