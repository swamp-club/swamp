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
import {
  applyLockfileDelta,
  diffLockfileEntries,
  emptyLockfileDelta,
  isEmptyLockfileDelta,
} from "./lockfile_delta.ts";

interface Entry {
  version: string;
  files?: string[];
}

Deno.test("diffLockfileEntries: reports added, changed and removed entries", () => {
  const delta = diffLockfileEntries<Entry>(
    {
      "@a/x": { version: "1" },
      "@a/y": { version: "1" },
      "@a/z": { version: "1" },
    },
    {
      "@a/x": { version: "1" },
      "@a/y": { version: "2" },
      "@a/w": { version: "1" },
    },
  );
  assertEquals(delta, {
    upserts: { "@a/y": { version: "2" }, "@a/w": { version: "1" } },
    removals: ["@a/z"],
  });
});

Deno.test("diffLockfileEntries: ignores object key order", () => {
  const delta = diffLockfileEntries<Entry>(
    { "@a/x": { version: "1", files: ["f"] } },
    { "@a/x": { files: ["f"], version: "1" } },
  );
  assert(isEmptyLockfileDelta(delta));
});

Deno.test("applyLockfileDelta: keeps entries the delta does not name", () => {
  const remote = { "@peer/p": { version: "1" }, "@a/gone": { version: "1" } };
  const result = applyLockfileDelta<Entry>(remote, {
    upserts: { "@a/new": { version: "3" } },
    removals: ["@a/gone"],
  });
  assertEquals(result, {
    "@peer/p": { version: "1" },
    "@a/new": { version: "3" },
  });
  assertEquals(Object.keys(remote).length, 2);
});

Deno.test("emptyLockfileDelta: is empty and applies as identity", () => {
  const delta = emptyLockfileDelta<Entry>();
  assert(isEmptyLockfileDelta(delta));
  assertEquals(applyLockfileDelta({ "@a/x": { version: "1" } }, delta), {
    "@a/x": { version: "1" },
  });
});
