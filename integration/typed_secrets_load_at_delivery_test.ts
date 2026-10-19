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
 * vault.get() values load at delivery (swamp-club#3562, typed-secrets 2.3,
 * design/enablers/typed-secrets.md Sections 3.3 and 3.4), through real
 * workflow runs against an in-memory vault.
 *
 * The run's vault service audits every value read with its purpose, so a
 * load (`expression:vault-resolve`, a read for delivery) and a probe
 * (`expression:vault-check`, the existence check of a provider without
 * has()) are counted apart. The principal-scoped cases (a grant refusing a
 * key, the workflow's `vaults:` list, the reserved vault) run through serve
 * in serve_run_vault_scope_test.ts and serve_run_vault_scope_keys_test.ts;
 * the remote pre-load in remote_secrets_baseline_dispatch_payload_test.ts.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import {
  createVaultTestContext,
  type VaultTestContextOptions,
  type VaultTestContextResult,
} from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { JsonlVaultAuditRepository } from "../src/infrastructure/persistence/jsonl_vault_audit_repository.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import {
  holdsValue,
  isIssuedEntry,
} from "../src/domain/vaults/secret_bag_registry.ts";
import { LOAD_PURPOSE } from "../src/domain/vaults/secret_loader.ts";
import { PROBE_PURPOSE } from "../src/domain/vaults/secret_reference_check.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import {
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelEvaluateDeps,
  modelEvaluate,
} from "../src/libswamp/models/evaluate.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/workflows/evaluate.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { initializeTestRepo } from "./test_helpers.ts";

await initializeLogging({});

const VAULT = "deliver";

/** The authored reference to `key` in {@link VAULT}. */
function ref(key: string): string {
  return `\${{ vault.get('${VAULT}', '${key}') }}`;
}

interface Fixture {
  repoDir: string;
  vault: VaultTestContextResult;
}

/**
 * Runs `fn` against a fresh repo whose vault {@link VAULT} is the testing
 * package's in-memory vault, registered under a per-run type and audited.
 */
async function withFixture(
  options: VaultTestContextOptions,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const type = `@test/load-at-delivery-${crypto.randomUUID()}`;
  const vault = createVaultTestContext({ name: VAULT, ...options });
  vaultTypeRegistry.register({
    type,
    name: "Load-at-delivery test vault",
    description: "In-memory vault for typed-secrets 2.3 tests",
    isBuiltIn: false,
    createProvider: () => vault.vault,
  });
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3562-" });
  try {
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, type, {}, true),
    );
    await fn({ repoDir, vault });
  } finally {
    vaultTypeRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** The keys the run's vault service read for each purpose, sorted. */
async function auditedReads(
  repoDir: string,
): Promise<{ loads: string[]; probes: string[] }> {
  const hour = 3_600_000;
  const entries = await new JsonlVaultAuditRepository(repoDir)
    .findByTimeRange(new Date(Date.now() - hour), new Date(Date.now() + hour));
  const keysFor = (purpose: string) =>
    entries
      .filter((e) =>
        e.vaultName === VAULT && e.action === "get" &&
        e.callerContext === purpose
      )
      .map((e) => e.secretKey)
      .sort();
  return { loads: keysFor(LOAD_PURPOSE), probes: keysFor(PROBE_PURPOSE) };
}

/** Provider operations that touched `key`. */
function touched(vault: VaultTestContextResult, key: string): string[] {
  return vault.getOperations()
    .filter((op) => op.key === key)
    .map((op) => op.method);
}

/** What one execution of the recorder received. */
interface Delivery {
  args: Record<string, unknown>;
  globalArgs: Record<string, unknown>;
  /** Whether any vault.get entry of the run's registry held a value. */
  registryHeldVaultValue: boolean;
}

/**
 * Registers a per-run model whose `run` method records what it receives,
 * and fails its first `failures` executions.
 */
function registerRecorder(deliveries: Delivery[], failures = 0): string {
  const type = ModelType.create(`test/delivery-${crypto.randomUUID()}`);
  const schema = z.object({
    token: z.string().optional(),
    note: z.string().optional(),
  });
  let failing = failures;
  modelRegistry.register({
    type,
    version: "2026.10.19.1",
    globalArguments: schema,
    methods: {
      run: {
        description: "Records what it receives",
        arguments: schema,
        execute: (args, context) => {
          const registry = context.vaultSecrets?.registry;
          deliveries.push({
            args: { ...(args as Record<string, unknown>) },
            globalArgs: { ...context.globalArgs },
            registryHeldVaultValue: registry !== undefined &&
              [...registry.all()].some((entry) =>
                isIssuedEntry(entry) && !entry.dataOrigin && holdsValue(entry)
              ),
          });
          if (failing > 0) {
            failing--;
            return Promise.reject(new Error("this attempt fails"));
          }
          return Promise.resolve({});
        },
      },
    },
  });
  return type.normalized;
}

/** A step running the recorder with `key` in a global and a method argument. */
function recorderStep(
  type: string,
  name: string,
  key: string,
  extra: { guard?: string; dependsOn?: string } = {},
): Step {
  return Step.create({
    name,
    task: StepTask.directExecution(
      type,
      "recorder",
      "run",
      { note: `uses ${ref(key)}` },
      { token: ref(key) },
    ),
    guard: extra.guard,
    dependsOn: extra.dependsOn
      ? [{ step: extra.dependsOn, condition: TriggerCondition.succeeded() }]
      : undefined,
  });
}

function workflowOf(steps: Step[]): Workflow {
  return Workflow.create({
    name: `deliver-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [Job.create({ name: "main", steps })],
  });
}

interface RunOutcome {
  runId?: string;
  status?: string;
  errors: string[];
}

async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  extra: Workflow[] = [],
): Promise<RunOutcome> {
  const repo = new YamlWorkflowRepository(repoDir);
  for (const w of [workflow, ...extra]) await repo.save(w);
  const { repoDir: resolved, repoContext, datastoreConfig, syncService } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  const outcome: RunOutcome = { errors: [] };
  await executeWorkflowWithLocks(
    resolved,
    repoContext,
    datastoreConfig,
    { workflowIdOrName: workflow.name },
    new AbortController().signal,
    (event: WorkflowRunEvent) => {
      if (event.kind === "started" && event.parentRunId === undefined) {
        outcome.runId = event.runId;
      }
      if (event.kind === "completed") outcome.status = event.run.status;
      if (event.kind === "step_failed") outcome.errors.push(event.error);
      if (event.kind === "error") outcome.errors.push(event.error.message);
    },
    syncService,
    undefined,
    { syncGate: undefined },
  );
  return outcome;
}

/** Retries the failed run `runId` of `workflow`, as `workflow resume` does. */
async function retryRun(
  repoDir: string,
  workflow: Workflow,
  runId: string,
): Promise<string | undefined> {
  const { repoDir: resolved, repoContext, datastoreConfig } =
    await requireInitializedRepoUnlocked({ repoDir, outputMode: "log" });
  const deps = await createWorkflowRunDeps(
    resolved,
    repoContext,
    datastoreConfig,
  );
  const service = deps.createExecutionService(
    deps.workflowRepo,
    deps.runRepo,
    deps.repoDir,
    deps.catalogStore,
  );
  let status: string | undefined;
  for await (const event of service.resume(workflow.name, runId, {})) {
    if (event.kind === "completed") status = event.run.status;
  }
  return status;
}

for (const withExistence of [true, false]) {
  const path = withExistence ? "has()" : "probe";
  Deno.test(`load at delivery (${path}): two parallel steps each load the reference once, the run checks it once, and no registry entry holds a value`, async () => {
    await withFixture(
      { withExistence, secrets: { token: "s3cret-value" } },
      async ({ repoDir, vault }) => {
        const deliveries: Delivery[] = [];
        const type = registerRecorder(deliveries);
        try {
          const { status, errors } = await runWorkflow(
            repoDir,
            workflowOf([
              recorderStep(type, "a", "token"),
              recorderStep(type, "b", "token"),
            ]),
          );
          assertEquals(status, "succeeded", errors.join("\n"));
          assertEquals(deliveries.length, 2);
          for (const delivery of deliveries) {
            assertEquals(delivery.globalArgs.token, "s3cret-value");
            assertEquals(delivery.args.note, "uses s3cret-value");
            assertEquals(delivery.registryHeldVaultValue, false);
          }
          const { loads, probes } = await auditedReads(repoDir);
          assertEquals(loads, ["token", "token"]);
          assertEquals(probes, withExistence ? [] : ["token"]);
          assertEquals(
            vault.getOperationsByMethod("has").length,
            withExistence ? 1 : 0,
          );
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    );
  });

  Deno.test(`load at delivery (${path}): a step a guard skips makes no load and no probe`, async () => {
    await withFixture(
      { withExistence, secrets: { token: "s3cret-value" } },
      async ({ repoDir, vault }) => {
        const deliveries: Delivery[] = [];
        const type = registerRecorder(deliveries);
        try {
          const { status, errors } = await runWorkflow(
            repoDir,
            workflowOf([
              recorderStep(type, "runs", "token"),
              // Its key is not in the vault: checking it would fail the run.
              recorderStep(type, "skipped", "absent", { guard: "${{ true }}" }),
            ]),
          );
          assertEquals(status, "succeeded", errors.join("\n"));
          assertEquals(deliveries.length, 1);
          assertEquals(touched(vault, "absent"), []);
          assertEquals((await auditedReads(repoDir)).loads, ["token"]);
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    );
  });

  Deno.test(`load at delivery (${path}): a retried step loads again and delivers the value rotated in between`, async () => {
    await withFixture(
      { withExistence, secrets: { token: "first-value" } },
      async ({ repoDir, vault }) => {
        const deliveries: Delivery[] = [];
        const type = registerRecorder(deliveries, 1);
        try {
          const workflow = workflowOf([recorderStep(type, "flaky", "token")]);
          const first = await runWorkflow(repoDir, workflow);
          assertEquals(first.status, "failed");
          await vault.vault.put("token", "rotated-value");

          assertEquals(
            await retryRun(repoDir, workflow, first.runId!),
            "succeeded",
          );
          assertEquals(
            deliveries.map((d) => d.globalArgs.token),
            ["first-value", "rotated-value"],
          );
          const { loads, probes } = await auditedReads(repoDir);
          assertEquals(loads, ["token", "token"]);
          // A retry is a new execution of the run, with its own registry.
          assertEquals(probes, withExistence ? [] : ["token", "token"]);
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    );
  });
}

Deno.test("load at delivery: a missing key fails the step at evaluation with secret_reference_unavailable, before any load", async () => {
  await withFixture(
    { withExistence: true, secrets: {} },
    async ({ repoDir }) => {
      const deliveries: Delivery[] = [];
      const type = registerRecorder(deliveries);
      try {
        const { status, errors } = await runWorkflow(
          repoDir,
          workflowOf([recorderStep(type, "missing", "absent")]),
        );
        assertEquals(status, "failed");
        assertStringIncludes(
          errors.join("\n"),
          `): Secret 'absent' not found in vault '${VAULT}'`,
        );
        assertEquals(deliveries, []);
        assertEquals(await auditedReads(repoDir), { loads: [], probes: [] });
      } finally {
        modelRegistry.invalidateType(type);
      }
    },
  );
});

Deno.test("load at delivery: a key the provider's credentials cannot read fails at evaluation with the provider's error", async () => {
  for (const withExistence of [true, false]) {
    await withFixture(
      {
        withExistence,
        secrets: { token: "s3cret-value" },
        unauthorizedKeys: ["token"],
      },
      async ({ repoDir }) => {
        const deliveries: Delivery[] = [];
        const type = registerRecorder(deliveries);
        try {
          const { status, errors } = await runWorkflow(
            repoDir,
            workflowOf([recorderStep(type, "denied", "token")]),
          );
          assertEquals(status, "failed");
          const message = errors.join("\n");
          assertStringIncludes(
            message,
            `Access denied to secret 'token' in test vault '${VAULT}'`,
          );
          assertEquals(message.includes("s3cret-value"), false);
          assertEquals(deliveries, []);
          assertEquals((await auditedReads(repoDir)).loads, []);
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    );
  }
});

Deno.test("load at delivery: a child workflow's step loads through the registry its parent's run shares, checked once for the run", async () => {
  await withFixture(
    { secrets: { token: "s3cret-value" } },
    async ({ repoDir }) => {
      const deliveries: Delivery[] = [];
      const type = registerRecorder(deliveries);
      try {
        const child = Workflow.create({
          name: `deliver-child-${crypto.randomUUID().slice(0, 8)}`,
          jobs: [Job.create({
            name: "main",
            steps: [recorderStep(type, "in-child", "token")],
          })],
        });
        const parent = workflowOf([
          recorderStep(type, "in-parent", "token"),
          Step.create({
            name: "call-child",
            task: StepTask.workflow(child.name),
            dependsOn: [{
              step: "in-parent",
              condition: TriggerCondition.succeeded(),
            }],
          }),
        ]);
        const { status, errors } = await runWorkflow(repoDir, parent, [child]);
        assertEquals(status, "succeeded", errors.join("\n"));
        assertEquals(
          deliveries.map((d) => d.globalArgs.token),
          ["s3cret-value", "s3cret-value"],
        );
        const { loads, probes } = await auditedReads(repoDir);
        assertEquals(loads, ["token", "token"]);
        assertEquals(probes, ["token"]);
      } finally {
        modelRegistry.invalidateType(type);
      }
    },
  );
});

Deno.test("load at delivery: a task selector and a child workflow reference written as vault.get receive their values, as they did from the eager read", async () => {
  await withFixture(
    {
      withExistence: true,
      secrets: { token: "s3cret-value", model: "recorder" },
    },
    async ({ repoDir, vault }) => {
      const deliveries: Delivery[] = [];
      const type = registerRecorder(deliveries);
      try {
        const child = Workflow.create({
          name: `deliver-child-${crypto.randomUUID().slice(0, 8)}`,
          jobs: [Job.create({
            name: "main",
            steps: [recorderStep(type, "in-child", "token")],
          })],
        });
        await vault.vault.put("child", child.name);
        const parent = workflowOf([
          Step.create({
            name: "selected",
            task: StepTask.directExecution(
              type,
              ref("model"),
              "run",
              { note: "selected" },
            ),
          }),
          Step.create({
            name: "call-child",
            task: StepTask.workflow(ref("child")),
          }),
        ]);
        const { status, errors } = await runWorkflow(repoDir, parent, [child]);
        assertEquals(status, "succeeded", errors.join("\n"));
        assertEquals(
          deliveries.map((d) => d.args.note).sort(),
          ["selected", "uses s3cret-value"],
        );
        const { loads } = await auditedReads(repoDir);
        assertEquals(loads, ["child", "model", "token"]);
      } finally {
        modelRegistry.invalidateType(type);
      }
    },
  );
});

Deno.test("load at delivery: swamp behavior evaluate and swamp workflow evaluate evaluate no vault.get, so they check and load nothing", async () => {
  await withFixture(
    { secrets: {} },
    async ({ repoDir, vault }) => {
      const deliveries: Delivery[] = [];
      const type = registerRecorder(deliveries);
      try {
        // Both name a key the vault does not hold: evaluating a vault.get
        // would fail. Evaluate defers it, as before.
        const { repoContext } = await requireInitializedRepoUnlocked({
          repoDir,
          outputMode: "log",
        });
        const definition = Definition.create({
          name: "deferred",
          globalArguments: { token: ref("absent") },
          methods: { run: { arguments: { note: `uses ${ref("absent")}` } } },
        });
        await repoContext.definitionRepo.save(
          ModelType.create(type),
          definition,
        );
        const workflow = workflowOf([recorderStep(type, "a", "absent")]);
        await new YamlWorkflowRepository(repoDir).save(workflow);

        const ctx = createLibSwampContext({});
        const modelEvents = [];
        for await (
          const event of modelEvaluate(
            ctx,
            createModelEvaluateDeps(repoDir),
            { modelIdOrName: definition.name },
          )
        ) {
          modelEvents.push(event.kind);
        }
        const workflowEvents = [];
        for await (
          const event of workflowEvaluate(
            ctx,
            createWorkflowEvaluateDeps(repoDir, repoContext.workflowRepo),
            { workflowIdOrName: workflow.name, inputs: {} },
          )
        ) {
          workflowEvents.push(event.kind);
        }

        assertEquals(modelEvents.includes("error"), false);
        assertEquals(modelEvents.at(-1), "completed");
        assertEquals(workflowEvents.includes("error"), false);
        assertEquals(workflowEvents.at(-1), "completed");
        assertEquals(vault.getOperations().filter((op) => op.key), []);
        assertEquals(await auditedReads(repoDir), { loads: [], probes: [] });
      } finally {
        modelRegistry.invalidateType(type);
      }
    },
  );
});

Deno.test("load at delivery: a local_encryption secret its vault cannot decrypt passes the existence check and fails at load, after the step's output record exists, naming no value", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3562-" });
  const deliveries: Delivery[] = [];
  const type = registerRecorder(deliveries);
  try {
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, "local_encryption", {
        auto_generate: true,
        base_dir: repoDir,
      }, true),
    );
    const vaults = await VaultService.fromRepository(repoDir);
    await vaults.put(VAULT, "token", "s3cret-value");
    // The file is present but no longer decrypts, as in a clone whose key
    // differs: has() answers true, and get() fails.
    await Deno.writeTextFile(
      join(
        repoDir,
        ".swamp",
        "secrets",
        "local_encryption",
        VAULT,
        "token.enc",
      ),
      "not a ciphertext",
    );

    const { status, errors } = await runWorkflow(
      repoDir,
      workflowOf([recorderStep(type, "undecryptable", "token")]),
    );

    assertEquals(status, "failed");
    const message = errors.join("\n");
    assertStringIncludes(
      message,
      `Failed to load secret 'token' from vault '${VAULT}' (at `,
    );
    assertEquals(message.includes("s3cret-value"), false);
    assertEquals(deliveries, []);
    assertEquals(await auditedReads(repoDir), { loads: [], probes: [] });
    // The step's output record was saved before the load, and is failed.
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "log",
    });
    const outputs = await repoContext.outputRepo.findAll(
      ModelType.create(type),
    );
    assertEquals(outputs.map((output) => output.status), ["failed"]);
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
