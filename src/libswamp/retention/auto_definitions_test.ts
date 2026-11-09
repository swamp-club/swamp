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

import "../../domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import {
  type AutoDefinitionLockHandle,
  type AutoDefinitionRetentionSources,
  createAutoDefinitionReaper,
} from "./auto_definitions.ts";
import { runRepoRetention } from "./run.ts";
import {
  DAY_MS,
  pathExists,
  saveAgedAutoDefinition,
  saveAgedDataVersions,
  saveAgedOutput,
} from "./retention_fixture_test_helpers.ts";

await initializeLogging({});

const TYPE = ModelType.create("command/shell");
const CUTOFF_DAYS = 30;

interface Fixture {
  repoDir: string;
  autoDir: string;
  autoRepo: YamlDefinitionRepository;
  outputRepo: YamlOutputRepository;
  dataRepo: FileSystemUnifiedDataRepository;
  evaluatedRepo: YamlEvaluatedDefinitionRepository;
  workflows: Workflow[];
  sources(
    overrides?: Partial<AutoDefinitionRetentionSources>,
  ): AutoDefinitionRetentionSources;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-autodef-ret-" });
  const catalog = new CatalogStore(catalogDbPath(repoDir));
  try {
    const autoDir = swampPath(repoDir, "auto-definitions");
    const outputRepo = new YamlOutputRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
    const evaluatedRepo = new YamlEvaluatedDefinitionRepository(repoDir);
    const workflows: Workflow[] = [];
    const autoRepo = new YamlDefinitionRepository(
      repoDir,
      undefined,
      autoDir,
      false,
    );
    await fn({
      repoDir,
      autoDir,
      autoRepo,
      outputRepo,
      dataRepo,
      evaluatedRepo,
      workflows,
      sources: (overrides = {}) => ({
        autoDefinitionsDir: autoDir,
        autoDefinitionRepo: autoRepo,
        outputRepo,
        dataRepo,
        evaluatedDefinitionRepo: evaluatedRepo,
        workflowRepo: { findAll: () => Promise.resolve(workflows) },
        ...overrides,
      }),
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

const cutoff = () => new Date(Date.now() - CUTOFF_DAYS * DAY_MS);

async function drain(
  sources: AutoDefinitionRetentionSources,
  options: { dryRun?: boolean } = {},
): Promise<string[]> {
  const reaper = createAutoDefinitionReaper(sources);
  const removed: string[] = [];
  for (let i = 0; i < 100; i++) {
    const batch = await reaper.collectBatch(cutoff(), 2, options);
    removed.push(...batch.removed.map((c) => c.definition.name));
    if (!batch.more) return removed.sort();
  }
  throw new Error("reaper never finished");
}

Deno.test("createAutoDefinitionReaper: removes only idle definitions past the cutoff", async () => {
  await withFixture(async (f) => {
    const old = 40 * DAY_MS;
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "idle",
      old,
    );
    const young = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "young",
      DAY_MS,
    );
    const withOutput = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "with-output",
      old,
    );
    await saveAgedOutput(f.outputRepo, TYPE, old, {
      definitionId: withOutput.definition.id,
    });
    const withData = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "with-data",
      old,
    );
    await saveAgedDataVersions(
      f.dataRepo,
      TYPE,
      withData.definition.id,
      "item",
      [old],
    );
    const referenced = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "referenced",
      old,
    );
    f.workflows.push(Workflow.create({
      id: crypto.randomUUID(),
      name: "uses-referenced",
      jobs: [Job.create({
        name: "job1",
        steps: [Step.create({
          name: "step1",
          task: StepTask.model("referenced", "run"),
        })],
      })],
    }));
    const grant = ModelType.create("swamp/grant");
    const exempt = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      grant,
      "a-grant",
      old,
    );

    assertEquals(await drain(f.sources()), ["idle"]);
    assertEquals(await pathExists(idle.path), false);
    for (const kept of [young, withOutput, withData, referenced, exempt]) {
      assert(await pathExists(kept.path), kept.definition.name);
    }
  });
});

Deno.test("createAutoDefinitionReaper: a data directory holding only the lock file counts as no data", async () => {
  await withFixture(async (f) => {
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "locked-once",
      40 * DAY_MS,
    );
    const dataDir = join(
      swampPath(f.repoDir, "data"),
      TYPE.normalized,
      idle.definition.id,
    );
    await ensureDir(dataDir);
    await Deno.writeTextFile(join(dataDir, ".lock"), "{}");
    assertEquals(await drain(f.sources()), ["locked-once"]);
  });
});

Deno.test("createAutoDefinitionReaper: dry run lists without removing", async () => {
  await withFixture(async (f) => {
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "idle",
      40 * DAY_MS,
    );
    assertEquals(await drain(f.sources(), { dryRun: true }), ["idle"]);
    assert(await pathExists(idle.path));
  });
});

Deno.test("createAutoDefinitionReaper: skips a definition whose model lock is held", async () => {
  await withFixture(async (f) => {
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "busy",
      40 * DAY_MS,
    );
    const tried: string[] = [];
    const removed = await drain(f.sources({
      tryLockModel: (_type, id) => {
        tried.push(id);
        return Promise.resolve(null);
      },
    }));
    assertEquals(removed, []);
    assertEquals(tried, [idle.definition.id]);
    assert(await pathExists(idle.path));
  });
});

Deno.test("createAutoDefinitionReaper: keeps a definition whose output appears before its lock is taken", async () => {
  await withFixture(async (f) => {
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "raced",
      40 * DAY_MS,
    );
    let released = false;
    const removed = await drain(f.sources({
      tryLockModel: async (type, id): Promise<AutoDefinitionLockHandle> => {
        await saveAgedOutput(f.outputRepo, type, 0, { definitionId: id });
        return {
          release: () => {
            released = true;
            return Promise.resolve();
          },
        };
      },
    }));
    assertEquals(removed, []);
    assert(released);
    assert(await pathExists(idle.path));
  });
});

Deno.test("runRepoRetention: autoDefinitions removes idle definitions only when its own key is set", async () => {
  await withFixture(async (f) => {
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "idle",
      40 * DAY_MS,
    );
    const deps = {
      repoDir: f.repoDir,
      runBatch: <T>(fn: () => Promise<T>) => fn(),
      autoDefinitions: {
        autoDefinitionsDir: f.autoDir,
        autoDefinitionRepo: f.autoRepo,
        outputRepo: f.outputRepo,
        dataRepo: f.dataRepo,
        evaluatedDefinitionRepo: f.evaluatedRepo,
        workflowRepo: { findAll: () => Promise.resolve(f.workflows) },
      },
    };
    await runRepoRetention(deps, {
      policy: RetentionPolicy.fromConfig({ retention: "1d" }),
    });
    assert(await pathExists(idle.path), "a shared default never applies");

    const result = await runRepoRetention(deps, {
      policy: RetentionPolicy.fromConfig({
        autoDefinitions: `${CUTOFF_DAYS}d`,
      }),
    });
    assertEquals(
      result.kinds.find((k) => k.kind === "autoDefinitions")?.deleted,
      1,
    );
    assertEquals(await pathExists(idle.path), false);
  });
});

Deno.test("runRepoRetention: an auto-definition whose last output expires in the same pass is removed", async () => {
  await withFixture(async (f) => {
    const old = 40 * DAY_MS;
    const idle = await saveAgedAutoDefinition(
      f.autoRepo,
      f.autoDir,
      TYPE,
      "ran-long-ago",
      old,
    );
    await saveAgedOutput(f.outputRepo, TYPE, old, {
      definitionId: idle.definition.id,
    });
    await runRepoRetention(
      {
        repoDir: f.repoDir,
        runBatch: (fn) => fn(),
        autoDefinitions: {
          autoDefinitionsDir: f.autoDir,
          autoDefinitionRepo: f.autoRepo,
          outputRepo: f.outputRepo,
          dataRepo: f.dataRepo,
          evaluatedDefinitionRepo: f.evaluatedRepo,
          workflowRepo: { findAll: () => Promise.resolve([]) },
        },
      },
      {
        policy: RetentionPolicy.fromConfig({
          outputs: "7d",
          autoDefinitions: `${CUTOFF_DAYS}d`,
        }),
      },
    );
    assertEquals(await pathExists(idle.path), false);
  });
});
