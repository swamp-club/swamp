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

/**
 * Model-based property of automatic retention (swamp-club#3473), over the
 * real collectors and the real filesystem repositories: whatever the items,
 * retention per kind, batch size, and passes cut short in between, once a
 * pass completes
 *
 * (i) no deletable item older than its kind's cutoff remains, and
 * (ii) every item newer than its cutoff, every unfinished run and output,
 *      and every exempt data version remains.
 *
 * Ages sit half a day off any whole-day retention, so the few seconds a run
 * takes never move an item across its cutoff.
 */

import "../../domain/models/models.ts";
import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import { RETENTION_EXEMPT_MODEL_TYPES } from "../../domain/retention/retention_exemptions.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import {
  catalogDbPath,
  removeCatalogDb,
} from "../../infrastructure/persistence/repository_factory.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { runRepoRetention } from "./run.ts";
import {
  type AgedOutput,
  type AgedRun,
  DAY_MS,
  type FixtureRunStatus,
  fixtureWorkflow,
  pathExists,
  saveAgedDataVersions,
  saveAgedOutput,
  saveAgedRun,
  TERMINAL_FIXTURE_STATUSES,
} from "./retention_fixture_test_helpers.ts";

await initializeLogging({});

const OUTPUT_TYPE = ModelType.create("command/shell");
const DATA_TYPES = ["test/retention-a", "test/retention-b"];
const EXEMPT_TYPES = [...RETENTION_EXEMPT_MODEL_TYPES];

const arbAgeDays = fc.integer({ min: 0, max: 14 }).map((d) => d + 0.5);

const arbRun = fc.record({
  status: fc.constantFrom<FixtureRunStatus>(
    "succeeded",
    "failed",
    "cancelled",
    "running",
    "suspended",
  ),
  ageDays: arbAgeDays,
  snapshot: fc.boolean(),
});

const arbOutput = fc.record({
  ageDays: arbAgeDays,
  running: fc.boolean(),
});

const arbDataName = fc.record({
  // Half the names are exempt access or serve state.
  type: fc.oneof(
    fc.constantFrom(...DATA_TYPES),
    fc.constantFrom(...EXEMPT_TYPES),
  ),
  // Oldest first: a later version is never older than an earlier one.
  versionAges: fc.array(arbAgeDays, { minLength: 1, maxLength: 3 }).map((
    ages,
  ) => [...ages].sort((a, b) => b - a)),
});

const arbRetentionDays = fc.option(fc.integer({ min: 1, max: 12 }), {
  nil: undefined,
});

const arbScenario = fc.record({
  runs: fc.array(arbRun, { maxLength: 6 }),
  outputs: fc.array(arbOutput, { maxLength: 5 }),
  data: fc.array(arbDataName, { maxLength: 5 }),
  retention: fc.record({
    workflowRuns: arbRetentionDays,
    outputs: arbRetentionDays,
    data: arbRetentionDays,
  }),
  batchSize: fc.integer({ min: 1, max: 4 }),
  // Pass i stops after stops[i] batch checks; after them, passes run free.
  stops: fc.array(fc.nat(5), { maxLength: 4 }),
});

type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

function expired(ageDays: number, retentionDays: number | undefined): boolean {
  return retentionDays !== undefined && ageDays > retentionDays;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-prop-" });
  try {
    return await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function checkScenario(scenario: Scenario): Promise<void> {
  await withTempDir(async (repoDir) => {
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    const snapshotRepo = new YamlEvaluatedWorkflowRepository(repoDir);
    const snapshotsDir = swampPath(repoDir, "workflows-evaluated");
    const outputRepo = new YamlOutputRepository(repoDir);
    const workflow = fixtureWorkflow();

    const runs: { spec: Scenario["runs"][number]; saved: AgedRun }[] = [];
    for (const spec of scenario.runs) {
      runs.push({
        spec,
        saved: await saveAgedRun(
          runRepo,
          workflow,
          spec.status,
          spec.ageDays * DAY_MS,
          spec.snapshot
            ? {
              repo: snapshotRepo,
              baseDir: snapshotsDir,
              ageMs: spec.ageDays * DAY_MS,
            }
            : undefined,
        ),
      });
    }

    const outputs: { spec: Scenario["outputs"][number]; saved: AgedOutput }[] =
      [];
    for (const spec of scenario.outputs) {
      outputs.push({
        spec,
        saved: await saveAgedOutput(
          outputRepo,
          OUTPUT_TYPE,
          spec.ageDays * DAY_MS,
          { running: spec.running },
        ),
      });
    }

    const dataBase = swampPath(repoDir, "data");
    const names: {
      spec: Scenario["data"][number];
      type: ModelType;
      modelId: string;
      versions: number[];
    }[] = [];
    const catalog = new CatalogStore(catalogDbPath(repoDir));
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        repoDir,
        undefined,
        catalog,
      );
      for (const [i, spec] of scenario.data.entries()) {
        const type = ModelType.create(spec.type);
        const modelId = `model-${i}`;
        names.push({
          spec,
          type,
          modelId,
          versions: await saveAgedDataVersions(
            dataRepo,
            type,
            modelId,
            `item-${i}`,
            spec.versionAges.map((d) => d * DAY_MS),
          ),
        });
      }
    } finally {
      catalog.close();
    }
    await removeCatalogDb(repoDir);

    const policy = RetentionPolicy.fromConfig({
      ...(scenario.retention.workflowRuns === undefined
        ? {}
        : { workflowRuns: `${scenario.retention.workflowRuns}d` }),
      ...(scenario.retention.outputs === undefined
        ? {}
        : { outputs: `${scenario.retention.outputs}d` }),
      ...(scenario.retention.data === undefined
        ? {}
        : { data: `${scenario.retention.data}d` }),
    });

    let complete = false;
    for (let pass = 0; !complete; pass++) {
      if (pass > 100) throw new Error("retention never completed");
      const stopAfter = scenario.stops[pass];
      let checks = 0;
      const result = await runRepoRetention(
        { repoDir, runBatch: (fn) => fn() },
        {
          policy,
          batchSize: scenario.batchSize,
          ...(stopAfter === undefined
            ? {}
            : { isStopping: () => ++checks > stopAfter }),
        },
      );
      complete = result.complete;
    }

    for (const { spec, saved } of runs) {
      const gone = TERMINAL_FIXTURE_STATUSES.has(spec.status) &&
        expired(spec.ageDays, scenario.retention.workflowRuns);
      const what = `${spec.status} run ${spec.ageDays}d old, retention ${
        scenario.retention.workflowRuns ?? "-"
      }`;
      assertEquals(await pathExists(saved.yamlPath), !gone, what);
      assertEquals(await pathExists(saved.logPath), !gone, `log of ${what}`);
      if (saved.snapshotPath) {
        assertEquals(
          await pathExists(saved.snapshotPath),
          !gone,
          `snapshot of ${what}`,
        );
      }
    }

    for (const { spec, saved } of outputs) {
      const gone = !spec.running &&
        expired(spec.ageDays, scenario.retention.outputs);
      const what = `${
        spec.running ? "running" : "succeeded"
      } output ${spec.ageDays}d old, retention ${
        scenario.retention.outputs ?? "-"
      }`;
      assertEquals(await pathExists(saved.yamlPath), !gone, what);
      assertEquals(await pathExists(saved.logPath), !gone, `log of ${what}`);
    }

    for (const [i, { spec, type, modelId, versions }] of names.entries()) {
      const retention = scenario.retention.data;
      const exempt = RETENTION_EXEMPT_MODEL_TYPES.includes(spec.type);
      const latestAge = spec.versionAges[spec.versionAges.length - 1];
      const wholeNameGone = !exempt && expired(latestAge, retention);
      for (const [v, version] of versions.entries()) {
        const gone = !exempt &&
          (wholeNameGone || expired(spec.versionAges[v], retention));
        assertEquals(
          await pathExists(
            join(dataBase, type.normalized, modelId, `item-${i}`, `${version}`),
          ),
          !gone,
          `${spec.type} item-${i} v${version} (ages ${
            spec.versionAges.join(",")
          }), retention ${retention ?? "-"}`,
        );
      }
    }
  });
}

Deno.test("runRepoRetention: once complete, removes exactly the deletable items past their cutoff, across batch sizes and interrupted passes", async () => {
  await fc.assert(
    fc.asyncProperty(arbScenario, (scenario) => checkScenario(scenario)),
    { numRuns: 25 },
  );
});
