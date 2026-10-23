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

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
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
  createModelMethodRunDeps,
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelEvaluateDeps,
  isModelEvaluateAllData,
  modelEvaluate,
} from "../src/libswamp/models/evaluate.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { Data } from "../src/domain/data/data.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../src/libswamp/workflows/evaluate.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import { collect } from "../src/libswamp/testing.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";

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
      if (event.kind === "suspended") outcome.status = event.run.status;
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

for (
  const selector of [
    "inputs.?keyName.orValue('missing')",
    "run.inputs.?keyName.orValue('missing')",
    "self.item",
  ]
) {
  Deno.test(`nested late vault key: ${selector} survives parent and child resumes without copying resume bindings`, async () => {
    await withFixture(
      { withExistence: true, secrets: { token: "late-secret-value" } },
      async ({ repoDir, vault }) => {
        const deliveries: Delivery[] = [];
        const type = registerRecorder(deliveries);
        try {
          const consumer = Definition.create({ name: "late-consumer" });
          const { repoContext, datastoreConfig } =
            await requireInitializedRepoUnlocked({
              repoDir,
              outputMode: "log",
            });
          await repoContext.definitionRepo.save(
            ModelType.create(type),
            consumer,
          );
          const child = Workflow.create({
            name: "late-child",
            inputs: {
              properties: {
                token: { type: "string" },
                keyName: { type: "string", default: "wrong-child-key" },
              },
              required: ["token"],
            },
            jobs: [Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "gate",
                  task: StepTask.manualApproval("Use credential?"),
                }),
                Step.create({
                  name: "consume",
                  task: StepTask.model("late-consumer", "run", {
                    token: "${{ inputs.token }}",
                  }),
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
              ],
            })],
          });
          const parent = Workflow.create({
            name: "late-parent",
            inputs: {
              properties: {
                keyName: { type: "string" },
                items: { type: "array" },
              },
            },
            jobs: [Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "gate",
                  task: StepTask.manualApproval("Mint credential"),
                }),
                Step.create({
                  name: "call",
                  ...(selector === "self.item"
                    ? {
                      forEach: {
                        item: "item",
                        in: "${{ inputs.?items.orValue([]) }}",
                      },
                    }
                    : {}),
                  task: StepTask.workflow(child.name, {
                    token: `\${{ vault.get('${VAULT}', ${selector}) }}`,
                  }),
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
                Step.create({
                  name: "direct",
                  task: StepTask.model("late-consumer", "run", {
                    token:
                      `\${{ vault.get('${VAULT}', inputs.?keyName.orValue('missing')) }}`,
                  }),
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
              ],
            })],
          });
          const started = await runWorkflow(repoDir, parent, [child]);
          assertEquals(started.status, "suspended", started.errors.join("\n"));
          const deps = await createWorkflowRunDeps(
            repoDir,
            repoContext,
            datastoreConfig,
          );
          const service = () =>
            deps.createExecutionService(
              deps.workflowRepo,
              deps.runRepo,
              repoDir,
              deps.catalogStore,
            );
          const approve = async (workflow: Workflow): Promise<WorkflowRun> => {
            const run = await deps.runRepo.findLatestByWorkflowId(workflow.id);
            assertExists(run);
            const gate = run.getJob("main")!.getStep("gate")!;
            gate.recordApprovalDecision({
              approved: true,
              decidedBy: "user:test",
              decidedAt: new Date().toISOString(),
            });
            gate.succeed();
            await deps.runRepo.save(workflow.id, run);
            return run;
          };
          const before = await approve(parent);
          const unrelated = `not-a-child-binding-${crypto.randomUUID()}`;
          const resumed = await collect(
            service().resume(parent.name, before.id, {
              inputs: { keyName: "token", items: ["token"], unrelated },
            }),
          );
          const parentRun = await deps.runRepo.findLatestByWorkflowId(
            parent.id,
          );
          assertEquals(parentRun?.status, "suspended", JSON.stringify(resumed));
          assertEquals(deliveries.map((delivery) => delivery.args.token), [
            "late-secret-value",
          ]);

          const childRun = await approve(child);
          assertEquals((await auditedReads(repoDir)).loads, ["token"]);
          await vault.vault.put("token", "rotated-late-secret");
          const serialized = JSON.stringify(childRun.toData());
          assertEquals(serialized.includes(unrelated), false);
          assertEquals(serialized.includes("late-secret-value"), false);
          for (const record of childRun.deferredExpressions) {
            assertEquals(record.bindings.inputs?.keyName, undefined);
            assertEquals(record.bindings.run?.inputs?.keyName, undefined);
            assertEquals(record.bindings.self?.item, undefined);
          }
          const childEvents = await collect(
            service().resume(child.name, childRun.id),
          );
          const result = await deps.runRepo.findLatestByWorkflowId(child.id);
          assertEquals(
            result?.status,
            "succeeded",
            JSON.stringify(childEvents),
          );
          assertEquals(deliveries.map((delivery) => delivery.args.token), [
            "late-secret-value",
            "rotated-late-secret",
          ]);
          const cache = await new YamlEvaluatedWorkflowRepository(repoDir)
            .findByNameWithProvenance(child.name);
          assertEquals(
            JSON.stringify(cache).includes("late-secret-value"),
            false,
          );
          await collect(service().resume(parent.name, before.id));
          assertEquals(
            (await deps.runRepo.findLatestByWorkflowId(parent.id))?.status,
            "succeeded",
          );
        } finally {
          modelRegistry.invalidateType(type);
        }
      },
    );
  });
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

Deno.test("load at delivery: task selectors and child workflow references refuse vault.get before any delivery", async () => {
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
        const refusingSteps = [
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
        ];
        for (const step of refusingSteps) {
          const { status, errors } = await runWorkflow(
            repoDir,
            workflowOf([step]),
            [child],
          );
          assertEquals(status, "failed", errors.join("\n"));
          assertStringIncludes(errors.join("\n"), "secret_destination_refused");
          assertEquals(deliveries, []);
          const { loads } = await auditedReads(repoDir);
          assertEquals(loads, []);
        }
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

Deno.test("load at delivery: evaluate keeps secret refusals pending for single and all definitions, and only the consuming method fails", async () => {
  await withFixture(
    { withExistence: true, secrets: { token: "s3cret-value" } },
    async ({ repoDir, vault }) => {
      const type = ModelType.create(
        `@test/evaluate-refusals-${crypto.randomUUID()}`,
      );
      const deliveries: unknown[] = [];
      const method = {
        description: "Record delivery",
        arguments: z.object({ value: z.unknown() }),
        execute: (args: unknown) => {
          deliveries.push(args);
          return Promise.resolve({ dataHandles: [] });
        },
      };
      modelRegistry.register({
        type,
        version: "2026.10.23.1",
        methods: { text: method, size: method, whole: method, plain: method },
      });
      const { repoContext } = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
      try {
        const producer = Definition.create({ name: "holder" });
        await repoContext.definitionRepo.save(type, producer);
        await repoContext.unifiedDataRepo.save(
          type,
          producer.id,
          Data.create({
            name: "creds",
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 5,
            tags: {
              type: "resource",
              modelName: producer.name,
              "_swamp.sensitiveFields": JSON.stringify(["token"]),
            },
            ownerDefinition: {
              ownerType: "model-method",
              ownerRef: `${type.normalized}:${producer.id}`,
            },
          }),
          new TextEncoder().encode(
            JSON.stringify({ token: ref("token"), label: "public" }),
          ),
        );
        const attributes = "data.latest('holder', 'creds').attributes";
        const whole = `\${{ ${attributes} }}`;
        const text = `before ${whole} after`;
        const size = `\${{ size(${attributes}.token) }}`;
        const refusing = Definition.create({
          name: "refusing",
          methods: {
            text: { arguments: { value: text } },
            size: { arguments: { value: size } },
            whole: { arguments: { value: whole } },
            plain: { arguments: { value: "${{ 'still' + ' works' }}" } },
          },
        });
        const independent = Definition.create({
          name: "independent",
          methods: { plain: { arguments: { value: "${{ 1 + 1 }}" } } },
        });
        for (const definition of [refusing, independent]) {
          await repoContext.definitionRepo.save(type, definition);
        }
        const evalDeps = createModelEvaluateDeps(
          repoDir,
          undefined,
          repoContext.unifiedDataRepo,
          repoContext.catalogStore,
          repoContext.definitionRepo,
        );
        for (const input of [{ modelIdOrName: refusing.name }, {}]) {
          const events = await collect(
            modelEvaluate(createLibSwampContext(), evalDeps, input),
          );
          const completed = events.find((event) => event.kind === "completed");
          assertExists(completed);
          assertEquals(events.some((event) => event.kind === "error"), false);
          if (isModelEvaluateAllData(completed.data)) {
            assertEquals(completed.data.items.map((item) => item.name).sort(), [
              "holder",
              "independent",
              "refusing",
            ]);
            const cachedOther = await repoContext.evaluatedDefinitionRepo
              .findByName(type, independent.name);
            assertEquals(cachedOther?.getMethodArguments("plain"), {
              value: 2,
            });
          }
          const cached = await repoContext.evaluatedDefinitionRepo.findByName(
            type,
            refusing.name,
          );
          assertExists(cached);
          assertEquals(cached.getMethodArguments("text"), { value: text });
          assertEquals(cached.getMethodArguments("size"), { value: size });
          assertEquals(cached.getMethodArguments("whole"), {
            value: { token: ref("token"), label: "public" },
          });
        }
        assertEquals(
          vault.getOperations().filter((op) => op.method === "get"),
          [],
        );
        const runDeps = await createModelMethodRunDeps(repoDir, repoContext, {
          defaultVault: VAULT,
        });
        const run = (methodName: string) =>
          collect(modelMethodRun(createLibSwampContext(), runDeps, {
            modelIdOrName: refusing.name,
            methodName,
            inputs: {},
            lastEvaluated: false,
          }));
        for (const methodName of ["text", "size"]) {
          const events = await run(methodName);
          const errors = events.filter((event) => event.kind === "error");
          assertEquals(errors.length, 1);
          assertStringIncludes(
            errors[0].error.message,
            "secret_operation_unsupported",
          );
          assertEquals(deliveries, []);
        }
        assertEquals(
          vault.getOperations().filter((op) => op.method === "get"),
          [],
        );
        for (const methodName of ["plain", "whole"]) {
          const events = await run(methodName);
          assertEquals(events.filter((event) => event.kind === "error"), []);
        }
        assertEquals(deliveries, [
          { value: "still works" },
          { value: { token: "s3cret-value", label: "public" } },
        ]);
      } finally {
        modelRegistry.invalidateType(type);
        repoContext.catalogStore.close();
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
