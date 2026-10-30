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
import type { UnpushedFilesSummary } from "../../domain/datastore/datastore_sync_service.ts";
import { cacheWipeRefusal } from "./doctor_datastores.ts";

const count = fc.nat({ max: 50 });

const summary: fc.Arbitrary<UnpushedFilesSummary> = fc.record({
  unpushed: count,
  alreadyPresent: count,
  locallyModified: count,
  unknown: count,
  peerDeleted: count,
  remoteMovedOn: count,
  uploaded: count,
  pendingChanges: fc.boolean(),
}).map((counts) => ({
  ...counts,
  samplePaths: [],
  sampleAlreadyPresent: [],
  sampleModified: [],
  sampleUnknown: [],
  samplePeerDeleted: [],
}));

Deno.test("cacheWipeRefusal: refuses exactly when the cache holds what the remote lacks or a push is pending", () => {
  fc.assert(fc.property(summary, (s) => {
    const blocked = s.unpushed > 0 || s.alreadyPresent > 0 ||
      s.locallyModified > 0 || s.unknown > 0 || s.pendingChanges;
    assertEquals(cacheWipeRefusal(s, "/cache") !== undefined, blocked);
  }));
});

Deno.test("cacheWipeRefusal: stale copies and copies a peer deleted never change the decision", () => {
  fc.assert(fc.property(summary, count, count, (s, peerDeleted, moved) => {
    assertEquals(
      cacheWipeRefusal({ ...s, peerDeleted, remoteMovedOn: moved }, "/cache"),
      cacheWipeRefusal(s, "/cache"),
    );
  }));
});
