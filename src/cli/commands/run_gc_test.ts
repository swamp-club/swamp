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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";
import { runGcDataFromServer } from "./run_gc.ts";

await initializeLogging({});

Deno.test("runGcDataFromServer: defaults evaluatedSnapshotsDeleted to 0 for a server that omits it", () => {
  const data = runGcDataFromServer({
    workflowRunsDeleted: 2,
    workflowRunBytesReclaimed: 200,
    outputsDeleted: 1,
    outputBytesReclaimed: 100,
    totalBytesReclaimed: 300,
    dryRun: false,
  });

  assertEquals(data.evaluatedSnapshotsDeleted, 0);
  assertEquals(data.evaluatedSnapshotBytesReclaimed, 0);
  assertEquals(data.workflowRunsDeleted, 2);
  assertEquals(data.totalBytesReclaimed, 300);
});

Deno.test("runGcDataFromServer: keeps evaluatedSnapshotsDeleted from a current server", () => {
  const data = runGcDataFromServer({
    workflowRunsDeleted: 0,
    workflowRunBytesReclaimed: 0,
    outputsDeleted: 0,
    outputBytesReclaimed: 0,
    evaluatedSnapshotsDeleted: 4,
    evaluatedSnapshotBytesReclaimed: 400,
    totalBytesReclaimed: 400,
    dryRun: true,
  });

  assertEquals(data.evaluatedSnapshotsDeleted, 4);
  assertEquals(data.evaluatedSnapshotBytesReclaimed, 400);
});
