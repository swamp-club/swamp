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
import { DatabaseSync } from "node:sqlite";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { methodRunsOfModel } from "../src/cli/commands/model_cancel.ts";

// The unit tests build rows in memory. These read them back from the store,
// so a NULL definition_id column has to arrive as the null the selection
// treats as a row an older swamp registered.
const MODEL_TYPE = "command/shell";

async function withTracker(
  fn: (tracker: RunTrackerStore, dbPath: string) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cancel-scope-" });
  const dbPath = join(dir, "run_tracker.db");
  const tracker = new RunTrackerStore(dbPath);
  try {
    fn(tracker, dbPath);
  } finally {
    tracker.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function registerRun(tracker: RunTrackerStore, definitionId: string): string {
  const id = crypto.randomUUID();
  tracker.register(ActiveRun.createModelMethodRun({
    id,
    modelType: MODEL_TYPE,
    definitionId,
    methodName: "execute",
    pid: Deno.pid,
    hostname: "test-host",
  }));
  return id;
}

/** Clears a row's definition id, as a swamp before swamp-club#3244 left it. */
function forgetDefinition(dbPath: string, runId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE active_runs SET definition_id = NULL WHERE id = ?")
      .run(runId);
  } finally {
    db.close();
  }
}

function selectedIds(
  tracker: RunTrackerStore,
  definitionId: string,
  soleDefinitionOfType = false,
) {
  const { runs, unattributed } = methodRunsOfModel(tracker.findAllRunning(), {
    definitionId,
    modelType: MODEL_TYPE,
    soleDefinitionOfType,
  });
  return {
    runs: runs.map((r) => r.id),
    unattributed: unattributed.map((r) => r.id),
  };
}

Deno.test("methodRunsOfModel: over a real tracker, an idle model selects nothing while another model of its type runs (swamp-club#3244)", async () => {
  await withTracker((tracker) => {
    const sleeperRun = registerRun(tracker, "def-sleeper");

    assertEquals(selectedIds(tracker, "def-idle"), {
      runs: [],
      unattributed: [],
    });
    assertEquals(selectedIds(tracker, "def-sleeper").runs, [sleeperRun]);
  });
});

Deno.test("methodRunsOfModel: over a real tracker, a row with no definition id is selected only for the type's sole definition", async () => {
  await withTracker((tracker, dbPath) => {
    const legacyRun = registerRun(tracker, "def-sleeper");
    forgetDefinition(dbPath, legacyRun);

    assertEquals(selectedIds(tracker, "def-idle"), {
      runs: [],
      unattributed: [legacyRun],
    });
    assertEquals(selectedIds(tracker, "def-sleeper", true), {
      runs: [legacyRun],
      unattributed: [],
    });
  });
});
