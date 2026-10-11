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

// context.runModel evaluates its target definition's expressions as a
// standalone run does, at both places an invocation service is built: the
// workflow step executor and the CLI / serve model method run
// (swamp-club#3227).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  modelRegistry,
  type RunModelResult,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

type RepositoryContext = ReturnType<typeof createRepositoryContext>;

interface Fixture {
  repo: RepositoryContext;
  dir: string;
  secret: string;
  /** Global arguments the target's method received, one entry per run. */
  received: Record<string, unknown>[];
  /** What each runModel call returned to the caller. */
  results: RunModelResult[];
}

async function withRepo(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-model-resolve-" });
  const repo = createRepositoryContext({ repoDir: dir });
  const targetType = ModelType.create(`test/target-${crypto.randomUUID()}`);
  const callerType = ModelType.create(`test/caller-${crypto.randomUUID()}`);
  const received: Record<string, unknown>[] = [];
  const results: RunModelResult[] = [];
  modelRegistry.register({
    type: targetType,
    version: "2026.10.11.1",
    globalArguments: z.object({ url: z.string(), label: z.string() }),
    resources: {
      echo: {
        description: "What the method received",
        schema: z.object({ echo: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      show: {
        description: "Records and echoes its global arguments",
        arguments: z.object({}),
        execute: async (_args, context) => {
          received.push({ ...context.globalArgs });
          context.logger.info(`received ${context.globalArgs.url}`);
          const handle = await context.writeResource!("echo", "echo", {
            echo: `received ${context.globalArgs.url}`,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
  modelRegistry.register({
    type: callerType,
    version: "2026.10.11.1",
    methods: {
      call: {
        description: "Invokes the target through context.runModel",
        arguments: z.object({}),
        execute: async (_args, context) => {
          results.push(
            await context.runModel!({ definition: "target", method: "show" }),
          );
          return { dataHandles: [] };
        },
      },
    },
  });
  try {
    await repo.vaultConfigRepo.save(
      VaultConfig.create(
        crypto.randomUUID(),
        "nested-vault",
        "local_encryption",
        { auto_generate: true },
      ),
    );
    const secret = `https://secret-${crypto.randomUUID()}.invalid`;
    await (await VaultService.fromRepository(dir)).put(
      "nested-vault",
      "api_url",
      secret,
    );
    await repo.definitionRepo.save(
      targetType,
      Definition.create({
        name: "target",
        globalArguments: {
          url: "${{ vault.get(nested-vault, api_url) }}",
          label: '${{ "label-" + self.name }}',
        },
      }),
    );
    await repo.definitionRepo.save(
      callerType,
      Definition.create({ name: "caller" }),
    );
    await fn({ repo, dir, secret, received, results });
  } finally {
    repo.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function callerWorkflow(name: string, vaults?: string[]): Workflow {
  return Workflow.create({
    name,
    ...(vaults ? { vaults } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [
        Step.create({ name: "call", task: StepTask.model("caller", "call") }),
      ],
    })],
  });
}

async function runWorkflow(fx: Fixture, workflow: Workflow) {
  await fx.repo.workflowRepo.save(workflow);
  const deps = await createWorkflowRunDeps(fx.dir, fx.repo, {
    type: "filesystem",
    path: join(fx.dir, ".swamp"),
  });
  const service = deps.createExecutionService(
    fx.repo.workflowRepo,
    fx.repo.workflowRunRepo,
    fx.dir,
    fx.repo.catalogStore,
  );
  return await service.execute(workflow.name);
}

/**
 * Asserts the nested run wrote its echo artifact with the secret redacted,
 * and that no file under .swamp — run logs, run records, data, the evaluated
 * cache — holds the secret in plaintext (the vault stores it encrypted).
 */
async function assertSecretRedactedOnDisk(fx: Fixture): Promise<void> {
  let redactedEchoes = 0;
  for await (
    const entry of walk(join(fx.dir, ".swamp"), { includeDirs: false })
  ) {
    const text = await Deno.readTextFile(entry.path).catch(() => "");
    assertEquals(text.includes(fx.secret), false, entry.path);
    if (text.includes("received ***")) redactedEchoes++;
  }
  assertEquals(redactedEchoes, 1);
}

Deno.test("runModel from a workflow step resolves the target's vault and CEL expressions", async () => {
  await withRepo(async (fx) => {
    const run = await runWorkflow(fx, callerWorkflow("resolve-wf"));

    assertEquals(run.status, "succeeded", JSON.stringify(run.toData()));
    assertEquals(fx.results.map((r) => r.ok), [true]);
    assertEquals(fx.received, [{ url: fx.secret, label: "label-target" }]);
    await assertSecretRedactedOnDisk(fx);
  });
});

Deno.test("runModel from a model method run resolves the target's vault and CEL expressions", async () => {
  await withRepo(async (fx) => {
    const deps = await createModelMethodRunDeps(fx.dir, fx.repo);
    const events = await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: "caller",
        methodName: "call",
        inputs: {},
        lastEvaluated: false,
      }),
    );

    assertEquals(events.filter((e) => e.kind === "error"), []);
    assertEquals(fx.results.map((r) => r.ok), [true]);
    assertEquals(fx.received, [{ url: fx.secret, label: "label-target" }]);
    await assertSecretRedactedOnDisk(fx);
  });
});

Deno.test("runModel from a workflow step is held to the workflow's vaults list", async () => {
  await withRepo(async (fx) => {
    await runWorkflow(fx, callerWorkflow("scoped-wf", ["some-other-vault"]));

    assertEquals(fx.results.length, 1);
    const [result] = fx.results;
    assertEquals(result.ok, false);
    assertStringIncludes(
      (result as RunModelResult & { ok: false }).error.message,
      "Reading vault 'nested-vault' is refused",
    );
    assertEquals(fx.received, []);
  });
});
