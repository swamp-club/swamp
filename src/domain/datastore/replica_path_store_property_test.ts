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
import fc from "fast-check";
import { padFence } from "../datastore_v3/writer_lease.ts";
import {
  MAX_FENCE,
  parseReplicaPathFence,
  replicaPathFenceProblem,
} from "./replica_path_store.ts";

Deno.test("replicaPathFenceProblem: accepts exactly what padFence writes", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: MAX_FENCE }), (fence) => {
      const name = padFence(fence);
      assertEquals(replicaPathFenceProblem(name), undefined);
      assertEquals(parseReplicaPathFence(name), fence);
    }),
  );
});

Deno.test("replicaPathFenceProblem: refuses every name padFence cannot write", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 16 }), (name) => {
      const fence = parseReplicaPathFence(name);
      if (fence === undefined) {
        assertEquals(typeof replicaPathFenceProblem(name), "string");
      } else {
        // Anything accepted round-trips: core never builds another path.
        assertEquals(padFence(fence), name);
      }
    }),
  );
  assertThrows(() => padFence(0));
});
