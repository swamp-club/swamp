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

// A named `swamp model cancel` selects tracker rows by definition id. A row
// an older swamp registered has none (swamp-club#3244), so it is attributed
// from what its run left on disk: a workflow step's `running` method-run
// record, or the per-model lock a direct run holds. These tests wire the real
// run tracker, output repository and model lock together, since the unit
// tests only build rows and evidence in memory.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getLogger } from "@logtape/logtape";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { createDefinitionId } from "../src/domain/definitions/definition.ts";
import type { OutputRepository } from "../src/domain/models/repositories.ts";
import {
  createModelLock,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { findMethodRunsOfModel } from "../src/cli/commands/model_cancel.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const TYPE = ModelType.create("command/shell");

// Far above any real pid_max, so never this process.
const OTHER_PID = 2147483647;

interface Fixture {
  tracker: RunTrackerStore;
  outputRepo: OutputRepository;
  /** The running rows a cancel of `definitionId` selects, by id. */
  select(definitionId: string): Promise<{
    runs: string[];
    unattributed: string[];
  }>;
  /** Clears a row's definition id, as a swamp before swamp-club#3244 left it. */
  forgetDefinition(runId: string): void;
  lockOf(definitionId: string): ReturnType<typeof createModelLock>;
}

async function withRepo(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-cancel-scope-" });
  let tracker: RunTrackerStore | undefined;
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const { repoContext, datastoreConfig } =
      await requireInitializedRepoUnlocked({ repoDir, outputMode: "json" });
    const store = tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    const lockOf = (definitionId: string) =>
      createModelLock(datastoreConfig, TYPE.normalized, definitionId);
    await fn({
      tracker: store,
      outputRepo: repoContext.outputRepo,
      lockOf,
      forgetDefinition(runId) {
        const db = new DatabaseSync(join(swampPath(repoDir), "run_tracker.db"));
        try {
          db.prepare("UPDATE active_runs SET definition_id = NULL WHERE id = ?")
            .run(runId);
        } finally {
          db.close();
        }
      },
      async select(definitionId) {
        const { runs, unattributed } = await findMethodRunsOfModel(
          store.findAllRunning(),
          { definitionId, type: TYPE },
          {
            outputs: repoContext.outputRepo,
            inspectModelLock: async () =>
              (await lockOf(definitionId)).inspect(),
            logger: getLogger(["test"]),
          },
        );
        return {
          runs: runs.map((r) => r.id),
          unattributed: unattributed.map((r) => r.id),
        };
      },
    });
  } finally {
    tracker?.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** A direct method run's row: registered, with no record until it ends. */
function registerRun(
  { tracker }: Fixture,
  definitionId: string,
  pid: number,
  id: string = crypto.randomUUID(),
): string {
  tracker.register(ActiveRun.createModelMethodRun({
    id,
    modelType: TYPE.normalized,
    definitionId,
    methodName: "execute",
    pid,
    hostname: hostname(),
  }));
  return id;
}

/** A workflow step's method run: its record saved `running`, then its row. */
async function registerStepRun(
  fixture: Fixture,
  definitionId: string,
  pid: number,
): Promise<string> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(definitionId),
    methodName: "execute",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "workflow",
    },
  });
  output.markRunning(pid);
  await fixture.outputRepo.save(TYPE, "execute", output);
  return registerRun(fixture, definitionId, pid, output.id);
}

Deno.test("findMethodRunsOfModel: an idle model selects nothing while another model of its type runs (swamp-club#3244)", async () => {
  await withRepo(async (fixture) => {
    const idle = crypto.randomUUID();
    const sleeper = crypto.randomUUID();
    const sleeperRun = registerRun(fixture, sleeper, OTHER_PID);

    assertEquals(await fixture.select(idle), { runs: [], unattributed: [] });
    assertEquals((await fixture.select(sleeper)).runs, [sleeperRun]);
  });
});

Deno.test("findMethodRunsOfModel: a step row with no definition id goes to the model its running record names", async () => {
  await withRepo(async (fixture) => {
    const idle = crypto.randomUUID();
    const sleeper = crypto.randomUUID();
    const stepRun = await registerStepRun(fixture, sleeper, OTHER_PID);
    fixture.forgetDefinition(stepRun);

    assertEquals(await fixture.select(sleeper), {
      runs: [stepRun],
      unattributed: [],
    });
    assertEquals(await fixture.select(idle), { runs: [], unattributed: [] });
  });
});

Deno.test("findMethodRunsOfModel: a direct row with no definition id goes to the model whose lock its process holds", async () => {
  await withRepo(async (fixture) => {
    const idle = crypto.randomUUID();
    const sleeper = crypto.randomUUID();
    const directRun = registerRun(fixture, sleeper, Deno.pid);
    fixture.forgetDefinition(directRun);
    const lock = await fixture.lockOf(sleeper);
    await lock.acquire();
    try {
      assertEquals(await fixture.select(sleeper), {
        runs: [directRun],
        unattributed: [],
      });
      assertEquals(await fixture.select(idle), {
        runs: [],
        unattributed: [directRun],
      });
    } finally {
      await lock.release();
    }
  });
});

Deno.test("findMethodRunsOfModel: a row with no definition id, record or lock is nobody's", async () => {
  await withRepo(async (fixture) => {
    const sleeper = crypto.randomUUID();
    const directRun = registerRun(fixture, sleeper, OTHER_PID);
    fixture.forgetDefinition(directRun);

    assertEquals(await fixture.select(sleeper), {
      runs: [],
      unattributed: [directRun],
    });
  });
});
