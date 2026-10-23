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
import { join } from "@std/path";
import { hostname } from "node:os";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { trackedRunCounts } from "../src/domain/remote/run_progress.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";

Deno.test("trackedRunCounts: counts actual running rows without steps and deduplicates open connections", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "runs.db");
  const tracker = new RunTrackerStore(path);
  const reader = new RunTrackerStore(path);
  const id = crypto.randomUUID();
  try {
    tracker.register(
      ActiveRun.createWorkflowRun({
        id,
        workflowName: "workflow",
        pid: Deno.pid,
        hostname: hostname(),
      }),
    );
    tracker.register(
      ActiveRun.createWorkflowRun({
        id: crypto.randomUUID(),
        workflowName: "foreign",
        pid: Deno.pid,
        hostname: "another-host",
      }),
    );
    assertEquals(trackedRunCounts(), {
      workflow: 1,
      model_method: 0,
      unavailableSources: 0,
    });
    tracker.complete(id, "suspended");
    assertEquals(trackedRunCounts().workflow, 0);
    assertEquals(tracker.reactivate(id, Deno.pid, hostname()), true);
    assertEquals(trackedRunCounts().workflow, 1);
    tracker.close();
    assertEquals(trackedRunCounts().workflow, 1);
    reader.close();
    assertEquals(trackedRunCounts(), {
      workflow: 0,
      model_method: 0,
      unavailableSources: 0,
    });
  } finally {
    tracker.close();
    reader.close();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
