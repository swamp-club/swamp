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
import { createRecordingSyncService } from "./recording_sync_service.ts";
import { assertSyncServiceConformance } from "./datastore_conformance.ts";

Deno.test("createRecordingSyncService: records path and bare marks in order", async () => {
  const { service, marks } = createRecordingSyncService();
  await service.markDirty({ relPath: "data/a" });
  await service.markDirty();
  await service.markDirty({ relPath: "data/a" });
  assertEquals(marks, ["data/a", undefined, "data/a"]);
});

Deno.test("createRecordingSyncService: records pulls and pushes with their options, and does nothing else", async () => {
  const { service, events } = createRecordingSyncService();
  assertEquals(await service.pullChanged({ subdirs: ["config"] }), 0);
  await service.markDirty({ relPath: "x" });
  assertEquals(await service.pushChanged(), 0);
  assertEquals(events, [
    { kind: "pull", options: { subdirs: ["config"] } },
    { kind: "mark", relPath: "x" },
    { kind: "push", options: undefined },
  ]);
});

Deno.test("createRecordingSyncService: passes the sync service conformance suite", async () => {
  const { service } = createRecordingSyncService();
  await assertSyncServiceConformance(service);
});
