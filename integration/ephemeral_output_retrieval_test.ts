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

import "../src/domain/models/models.ts";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { z } from "zod";
import { behaviorCommand } from "../src/cli/commands/behavior.ts";
import { modelMethodCommand } from "../src/cli/commands/model_method_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import { Data } from "../src/domain/data/data.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";

await initializeLogging({});
type Repo = ReturnType<typeof createRepositoryContext>;
interface Fixture {
  dir: string;
  type: ModelType;
  definition: Definition;
  executions: string[];
}

async function withFixture(fn: (fx: Fixture) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3887-" });
  const type = ModelType.create(`test/ephemeral-${crypto.randomUUID()}`);
  const definition = Definition.create({
    name: "scratch",
    type: type.normalized,
  });
  const executions: string[] = [];
  modelRegistry.register({
    type,
    version: "2026.10.28.1",
    resources: {
      state: {
        description: "Transient state",
        schema: z.object({ value: z.string() }),
        lifetime: "ephemeral",
        garbageCollection: 20,
      },
      retained: {
        description: "Durable state",
        schema: z.object({ value: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    files: {
      blob: {
        description: "Transient file",
        contentType: "application/octet-stream",
        lifetime: "ephemeral",
        garbageCollection: 20,
      },
    },
    methods: {
      run: {
        description:
          "Write mixed outputs and read the transient state in the run",
        arguments: z.object({
          value: z.string(),
          fail: z.boolean().default(false),
        }),
        execute: async (args, context) => {
          const { value, fail } = args as { value: string; fail: boolean };
          const state = await context.writeResource!("state", "state", {
            value,
          });
          const blob = await context.createFileWriter!("blob", "blob").writeAll(
            new Uint8Array([0xff, 0, 1]),
          );
          const retained = await context.writeResource!(
            "retained",
            "retained",
            { value },
          );
          assertEquals(await context.readResource!("state"), { value });
          executions.push(value);
          if (fail) throw new Error("after mixed writes");
          return { dataHandles: [state, blob, retained] };
        },
      },
    },
  });
  try {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await new RepoMarkerRepository().write(RepoPath.create(dir), {
      swampVersion: "0.1.0",
      initializedAt: "2026-10-28T00:00:00.000Z",
      repoId: crypto.randomUUID(),
      tools: [],
    });
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      await repo.definitionRepo.save(type, definition);
      // A released direct CLI persisted this ephemeral v1. Keep it to catch
      // an erroneous post-run retrieval command selecting the old bytes.
      await repo.unifiedDataRepo.save(
        type,
        definition.id,
        Data.create({
          name: "state",
          contentType: "application/json",
          lifetime: "ephemeral",
          garbageCollection: 20,
          tags: { type: "resource", specName: "state" },
          ownerDefinition: {
            ownerType: "model-method",
            ownerRef: definition.id,
          },
        }),
        new TextEncoder().encode(JSON.stringify({ value: "legacy" })),
      );
    } finally {
      repo.catalogStore.close();
    }
    await fn({ dir, type, definition, executions });
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else await Deno.remove(dir, { recursive: true });
  }
}

async function readJson(
  repo: Repo,
  fx: Fixture,
  name: string,
  version?: number,
) {
  const bytes = await repo.unifiedDataRepo.getContent(
    fx.type,
    fx.definition.id,
    name,
    version,
  );
  assertExists(bytes, name);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

async function assertTransientRun(fx: Fixture, value: string, version: number) {
  // Reopen as a subsequent CLI invocation does, not the run's composite view.
  const repo = createRepositoryContext({ repoDir: fx.dir });
  try {
    assertEquals(await readJson(repo, fx, "state"), { value: "legacy" });
    assertEquals(
      await repo.unifiedDataRepo.listVersions(
        fx.type,
        fx.definition.id,
        "state",
      ),
      [1],
    );
    assertEquals(
      await repo.unifiedDataRepo.findByName(fx.type, fx.definition.id, "blob"),
      null,
    );
    assertEquals(await readJson(repo, fx, "retained", version), { value });
    const report = await readJson(repo, fx, "report-swamp-method-summary-json");
    const produced = report.dataProduced as Array<Record<string, unknown>>;
    for (const name of ["state", "blob"]) {
      const pointer = produced.find((p) => p.name === name);
      assertExists(pointer);
      assertEquals(pointer.availability, "ephemeral");
      assertEquals("retrievalCommand" in pointer, false);
    }
    const pointer = produced.find((p) => p.name === "retained");
    assertExists(pointer);
    const command = String(pointer.retrievalCommand);
    assertStringIncludes(command, `modelId == "${fx.definition.id}"`);
    const predicate = command.slice(
      "swamp data query '".length,
      command.indexOf("' --select"),
    );
    assertEquals(
      await new DataQueryService(repo.catalogStore, repo.unifiedDataRepo).query(
        predicate,
        { select: "content" },
      ),
      [{ value }],
    );
  } finally {
    repo.catalogStore.close();
  }
}

Deno.test("ephemeral output: both CLI spellings and direct-type execution preserve only durable data", async () => {
  await withFixture(async (fx) => {
    const spellings = [["behavior", "run"], ["model", "method", "run"]];
    let version = 0;
    for (const spelling of spellings) {
      for (const direct of [false, true]) {
        const value = `cli-${++version}`;
        const root = registerCompletionTypes(new Command()).globalOption(
          "--json",
          "JSON output",
        )
          .command("behavior", behaviorCommand)
          .command(
            "model",
            new Command().command("method", modelMethodCommand),
          );
        const target = direct
          ? [`@${fx.type.normalized}`, "run", "scratch"]
          : ["scratch", "run"];
        await root.parse([
          ...spelling,
          ...target,
          "--input",
          `value=${value}`,
          "--repo-dir",
          fx.dir,
          "--json",
        ]);
        await assertTransientRun(fx, value, version);
      }
    }
    assertEquals(fx.executions.length, 4);
  });
});

Deno.test("ephemeral output: serve factory scopes transient data per invocation and retains failed durable writes", async () => {
  await withFixture(async (fx) => {
    const repo = createRepositoryContext({ repoDir: fx.dir });
    try {
      // Reuse the exact deps object, as an input batch does, to test disposal.
      const deps = await createModelMethodRunDeps(fx.dir, repo, {
        directExecution: true,
      });
      for (const [index, fail] of [false, true, false].entries()) {
        const value = `serve-${index}`;
        const events = await collect(
          modelMethodRun(createLibSwampContext(), deps, {
            modelIdOrName: "scratch",
            methodName: "run",
            inputs: { value, fail },
            lastEvaluated: false,
            ...(index === 2
              ? { typeArg: fx.type.normalized, definitionName: "scratch" }
              : {}),
          }),
        );
        assertEquals(
          events.at(-1)?.kind,
          fail ? "error" : "completed",
          JSON.stringify(events),
        );
        await assertTransientRun(fx, value, index + 1);
      }
    } finally {
      repo.catalogStore.close();
    }
  });
});

Deno.test("ephemeral output: workflow reads its own transient output and a durable override advances persistent history", async () => {
  await withFixture(async (fx) => {
    const repo = createRepositoryContext({ repoDir: fx.dir });
    try {
      const deps = await createWorkflowRunDeps(fx.dir, repo, {
        type: "filesystem",
        path: join(fx.dir, ".swamp"),
      });
      let retainedCommand: string | undefined;
      for (const durable of [false, true, false]) {
        const value = durable ? "retained" : "transient";
        const workflow = Workflow.create({
          name: `capture-${crypto.randomUUID()}`,
          jobs: [Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "write",
                task: StepTask.model("scratch", "run", { value }),
                dataOutputOverrides: durable
                  ? [{ specName: "state", lifetime: "infinite" }, {
                    specName: "blob",
                    lifetime: "infinite",
                  }]
                  : [{ specName: "retained", lifetime: "ephemeral" }],
              }),
              Step.create({
                name: "read",
                task: StepTask.assert(
                  `data.latest("scratch", "state").attributes.value == "${value}"`,
                  "read current output",
                ),
                dependsOn: [{
                  step: "write",
                  condition: TriggerCondition.succeeded(),
                }],
              }),
            ],
          })],
        });
        await repo.workflowRepo.save(workflow);
        const events = await collect(
          workflowRun(createLibSwampContext(), deps, {
            workflowIdOrName: workflow.name,
          }),
        );
        assertEquals(events.at(-1)?.kind, "completed", JSON.stringify(events));
        if (durable) {
          const report = await readJson(
            repo,
            fx,
            "report-swamp-method-summary-json",
          );
          const produced = report.dataProduced as Array<
            Record<string, unknown>
          >;
          retainedCommand = String(
            produced.find((p) => p.name === "state")?.retrievalCommand,
          );
        }
        assertEquals(
          await repo.unifiedDataRepo.listVersions(
            fx.type,
            fx.definition.id,
            "state",
          ),
          durable || fx.executions.length === 3 ? [1, 2] : [1],
        );
      }
      assertExists(retainedCommand);
      const predicate = retainedCommand.slice(
        "swamp data query '".length,
        retainedCommand.indexOf("' --select"),
      );
      assertEquals(
        await new DataQueryService(repo.catalogStore, repo.unifiedDataRepo)
          .query(predicate, { select: "content" }),
        [{ value: "retained" }],
      );
      assertEquals(await readJson(repo, fx, "state", 2), { value: "retained" });
      assertEquals(await readJson(repo, fx, "state", 1), { value: "legacy" });
      assertEquals(
        await repo.unifiedDataRepo.getContent(
          fx.type,
          fx.definition.id,
          "blob",
          1,
        ),
        new Uint8Array([0xff, 0, 1]),
      );
      assertEquals(
        await repo.unifiedDataRepo.listVersions(
          fx.type,
          fx.definition.id,
          "retained",
        ),
        [1],
      );
      assertEquals(fx.executions, ["transient", "retained", "transient"]);
    } finally {
      repo.catalogStore.close();
    }
  });
});
