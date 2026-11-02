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
 * the vault answers existence itself and counts every value it hands out, so a
 * load is a load and a check costs nothing
 */

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
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
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import {} from "../src/domain/vaults/run_vault_access.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import {
  type DirectTypeResolver,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import { type Canary, generateCanaries } from "./canary_values.ts";
import { toRunData } from "../src/libswamp/workflows/run.ts";

await initializeLogging({});

export const VAULT = "prod";
export const TOKEN_KEY = "TOKEN";
export const SENTINEL_MARK = "__SWAMP_VSEC_";

export interface Received {
  password?: string;
  note?: string;
}

export interface Fixture {
  repoDir: string;
  type: string;
  canaries: Canary[];
  token: string;
  received: Received[];
  loads: string[];
  checks: string[];
  run: (
    workflow: Workflow,
    extra?: Workflow[],
    inputs?: Record<string, unknown>,
  ) => Promise<Run>;
  resume: (
    workflowName: string,
    runId: string,
  ) => Promise<Run>;
  replay: (workflowName: string) => Promise<Run>;
  rotate: (key: string, value: string) => void;
  approve: (workflowName: string, runId: string) => Promise<void>;
  saveWorkflow: (workflow: Workflow) => Promise<void>;
  editRun: (
    workflowName: string,
    runId: string,
    edit: (data: Record<string, unknown>) => void,
  ) => Promise<void>;
  hooks: { afterWrite?: () => void; directTypeResolver?: DirectTypeResolver };
  /**
   * writes one tagged record per canary class through a prior run of the real
   * writer, then clears the counters; expansion and the run-start pass read
   * data before any step runs, so the records must exist first
   */
  seed: () => Promise<void>;
  storedKey: (name: string) => Promise<string>;
  filesHolding: (value: string) => Promise<string[]>;
  forbidden: string[];
}

export interface Run {
  status?: string;
  runId?: string;
  events: WorkflowExecutionEvent[];
  errors: Map<string, string>;
  skipped: Map<string, unknown>;
  asserts: Map<string, { passed: boolean; message: string }>;
  record: string;
}

export const canaryName = (canary: Canary) => `c-${canary.class}`;

export async function withFixture(
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3730-" });
  const canaries = generateCanaries();
  const token = `tok${crypto.randomUUID().replaceAll("-", "")}`;
  const stored = new Map<string, string>([[TOKEN_KEY, token]]);
  const loads: string[] = [];
  const checks: string[] = [];
  const vaultType = `@test/typed-passes-vault-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: vaultType,
    name: "Counting vault with has()",
    description: "Serves canaries, answers existence, counts loads",
    isBuiltIn: false,
    createProvider: (name: string) => ({
      get: (key: string) => {
        loads.push(key);
        const value = stored.get(key);
        if (value === undefined) {
          return Promise.reject(new Error(`no value for key ${key}`));
        }
        return Promise.resolve(value);
      },
      has: (key: string) => {
        checks.push(key);
        return Promise.resolve(stored.has(key));
      },
      put: (key: string, value: string) => {
        stored.set(key, value);
        return Promise.resolve();
      },
      list: () => Promise.resolve([...stored.keys()]),
      getName: () => name,
    }),
  });
  const received: Received[] = [];
  const hooks: Fixture["hooks"] = {};
  const type = ModelType.create(
    `test/typed-passes-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.21.1",
    globalArguments: z.object({ globalPassword: z.string().optional() }),
    resources: {
      creds: {
        description: "Credentials",
        schema: z.object({
          password: z.string().meta({ sensitive: true }),
          host: z.string(),
        }),
        lifetime: "infinite",
        garbageCollection: 10,
        vaultName: VAULT,
      },
    },
    methods: {
      seed: {
        description: "Writes one record per canary class",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handles = [];
          for (const canary of canaries) {
            handles.push(
              await context.writeResource!("creds", canaryName(canary), {
                password: canary.value,
                host: canary.class,
              }),
            );
          }
          return { dataHandles: handles };
        },
      },
      write: {
        description: "Writes the main record",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!("creds", "main", {
            password: canaries.find((c) => c.class === "quotes")!.value,
            host: "main",
          });
          hooks.afterWrite?.();
          return { dataHandles: [handle] };
        },
      },
      writeClass: {
        description: "Writes the record of one canary class",
        arguments: z.object({ cls: z.string() }),
        execute: async (args, context) => {
          const cls = (args as { cls: string }).cls;
          const canary = canaries.find((c) => c.class === cls)!;
          const handle = await context.writeResource!(
            "creds",
            canaryName(canary),
            { password: canary.value, host: canary.class },
          );
          hooks.afterWrite?.();
          return { dataHandles: [handle] };
        },
      },
      consume: {
        description: "Records what it received",
        arguments: z.object({
          password: z.string().optional(),
          note: z.string().optional(),
        }),
        execute: (args, context) => {
          received.push({
            ...(args as Received),
            ...(context.globalArgs.globalPassword === undefined ? {} : {
              password: context.globalArgs.globalPassword as string,
            }),
          });
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  });
  try {
    await initializeTestRepo(repoDir);
    const writer = Definition.create({ name: "writer", type: type.normalized });
    await new YamlDefinitionRepository(repoDir).save(type, writer);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), VAULT, vaultType, {}),
    );
    const filesHolding = async (value: string): Promise<string[]> => {
      const found: string[] = [];
      for await (
        const entry of walk(join(repoDir, ".swamp"), { includeDirs: false })
      ) {
        // A file another connection closes between the walk and the read (a
        // SQLite -shm file) holds nothing to scan.
        const bytes = await Deno.readFile(entry.path).catch((error) => {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        });
        if (bytes === undefined) continue;
        if (new TextDecoder("latin1").decode(bytes).includes(value)) {
          found.push(entry.path.slice(repoDir.length));
        }
      }
      return found;
    };
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    const sensitiveValuesFor = () => {
      const redactor = new SecretRedactor();
      return {
        secretRedactor: redactor,
        sensitiveValues: new RunSensitiveValues(
          redactor,
          new SecretBagRegistry(),
        ),
      };
    };
    const drive = async (
      events: (
        service: WorkflowExecutionService,
      ) => AsyncIterable<WorkflowExecutionEvent>,
    ): Promise<Run> => {
      const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
      const result: Run = {
        events: [],
        errors: new Map(),
        skipped: new Map(),
        asserts: new Map(),
        record: "",
      };
      try {
        const service = new WorkflowExecutionService(
          workflowRepo,
          runRepo,
          repoDir,
          undefined,
          undefined,
          catalog,
          hooks.directTypeResolver,
        );
        for await (const event of events(service)) {
          result.events.push(event);
          if (event.kind === "started") result.runId = event.runId;
          // The record as it is written: a typed run's memory holds
          // sentinels, its file references.
          if (event.kind === "completed") {
            result.status = event.run.status;
            result.record = JSON.stringify(event.run.toPersistedData());
          }
          if (event.kind === "suspended") {
            result.status = "suspended";
            result.record = JSON.stringify(event.run.toPersistedData());
          }
          if (event.kind === "step_failed") {
            result.errors.set(event.stepId, event.error);
          }
          if (event.kind === "step_skipped") {
            result.skipped.set(event.stepId, event.guardResult);
          }
          if (event.kind === "assert_result") {
            result.asserts.set(event.stepId, {
              passed: event.passed,
              message: event.message,
            });
          }
        }
      } finally {
        catalog.close();
      }
      return result;
    };
    const run = async (
      workflow: Workflow,
      extra: Workflow[] = [],
      inputs?: Record<string, unknown>,
    ): Promise<Run> => {
      for (const w of [workflow, ...extra]) await workflowRepo.save(w);
      return await drive((service) =>
        service.run(workflow.name, {
          ...(inputs ? { inputs } : {}),
          ...sensitiveValuesFor(),
        })
      );
    };
    const resume = (
      workflowName: string,
      runId: string,
    ): Promise<Run> =>
      drive((service) =>
        service.resume(workflowName, runId, sensitiveValuesFor())
      );
    const replay = (workflowName: string): Promise<Run> =>
      drive((service) =>
        service.run(workflowName, {
          lastEvaluated: true,
          ...sensitiveValuesFor(),
        })
      );
    const rotate = (key: string, value: string): void => {
      stored.set(key, value);
    };
    const storedRun = async (workflowName: string, runId: string) => {
      const workflow = await workflowRepo.findByName(workflowName);
      assert(workflow, `no workflow ${workflowName}`);
      const run = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(runId),
      );
      assert(run, `no run ${runId}`);
      return { workflow, run };
    };
    const approve = async (
      workflowName: string,
      runId: string,
    ): Promise<void> => {
      const { workflow, run } = await storedRun(workflowName, runId);
      const waiting = run.findWaitingApprovalStep();
      assert(waiting, "no step waits for approval");
      const step = run.getJob(waiting.jobName)!.getStep(waiting.stepName)!;
      step.recordApprovalDecision({
        approved: true,
        decidedBy: "user:test",
        decidedAt: new Date().toISOString(),
      });
      step.succeed();
      await runRepo.save(workflow.id, run);
    };
    const saveWorkflow = (workflow: Workflow) => workflowRepo.save(workflow);
    const editRun = async (
      workflowName: string,
      runId: string,
      edit: (data: Record<string, unknown>) => void,
    ): Promise<void> => {
      const { workflow, run } = await storedRun(workflowName, runId);
      const data = run.toData() as unknown as Record<string, unknown>;
      edit(data);
      await runRepo.save(
        workflow.id,
        WorkflowRun.fromData(
          data as unknown as Parameters<
            typeof WorkflowRun.fromData
          >[0],
        ),
      );
    };
    const seed = async (): Promise<void> => {
      const seeded = await run(
        Workflow.create({
          name: `seed-${crypto.randomUUID().slice(0, 8)}`,
          jobs: [Job.create({ name: "main", steps: [seedStep()] })],
        }),
      );
      assertEquals(seeded.status, "succeeded", [...seeded.errors].join("\n"));
      loads.length = 0;
      checks.length = 0;
      received.length = 0;
    };
    const storedKey = async (name: string): Promise<string> => {
      const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
      try {
        const dataRepo = new FileSystemUnifiedDataRepository(
          repoDir,
          undefined,
          catalog,
          undefined,
          undefined,
          SOLO_NAMESPACE,
          undefined,
          undefined,
          () => Promise.resolve(null),
        );
        const content = await dataRepo.getContent(type, writer.id, name);
        assert(content, `no stored record ${name}`);
        const parsed = JSON.parse(new TextDecoder().decode(content)) as {
          password: string;
        };
        const match = /vault\.get\('[^']+', '([^']+)'\)/.exec(parsed.password);
        assert(match, `record ${name} holds no reference`);
        return match[1];
      } finally {
        catalog.close();
      }
    };
    await fn({
      repoDir,
      type: type.normalized,
      canaries,
      token,
      received,
      loads,
      checks,
      run,
      resume,
      replay,
      rotate,
      approve,
      saveWorkflow,
      editRun,
      hooks,
      seed,
      storedKey,
      filesHolding,
      forbidden: [
        ...canaries.filter((c) => c.unique).map((c) => c.value),
        token,
      ],
    });
  } finally {
    vaultTypeRegistry.invalidateType(vaultType);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

export const after = (step: string) => [{
  step,
  condition: TriggerCondition.succeeded(),
}];

export function seedStep(): Step {
  return Step.create({
    name: "seed",
    task: StepTask.model("writer", "seed", {}),
  });
}

export function consume(
  name: string,
  inputs: Record<string, unknown>,
  props: Partial<{
    guard: string;
    allowFailure: boolean;
    forEach: { item: string; in: string };
    dependsOn: string;
  }> = {},
): Step {
  return Step.create({
    name,
    task: StepTask.model("writer", "consume", inputs),
    dependsOn: props.dependsOn ? after(props.dependsOn) : undefined,
    guard: props.guard,
    allowFailure: props.allowFailure,
    forEach: props.forEach,
  });
}

export const quotes = (f: Fixture) =>
  f.canaries.find((c) => c.class === "quotes")!.value;
export const PASSWORD_CEL =
  "data.latest('writer', 'c-quotes').attributes.password";
export const PASSWORD = `\${{ ${PASSWORD_CEL} }}`;
export const TOKEN = `\${{ vault.get('${VAULT}', '${TOKEN_KEY}') }}`;

/**
 * a run-carrying event is judged through the libswamp run view, as json output
 * shows it, since the aggregate's memory holds sentinels; `allowed` text fed in
 * as data persists by design
 */
export async function assertNothingLeaked(
  f: Fixture,
  run: Run,
  options: { allowed?: readonly string[] } = {},
): Promise<void> {
  const strip = (text: string): string =>
    (options.allowed ?? []).reduce(
      (out, allowed) => out.split(allowed).join(""),
      text,
    );
  const events = strip(JSON.stringify(
    run.events.map((e) =>
      e.kind === "completed" || e.kind === "cancelled" || e.kind === "suspended"
        ? { ...e, run: toRunData(e.run) }
        : e
    ),
  ));
  const record = strip(run.record);
  for (const value of f.forbidden) {
    assertEquals(events.includes(value), false, `events hold ${value}`);
    assertEquals(record.includes(value), false, `record holds ${value}`);
    assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
  }
  assertEquals(events.includes(SENTINEL_MARK), false, "events hold a sentinel");
  assertEquals(
    record.includes(SENTINEL_MARK),
    false,
    "record holds a sentinel",
  );
  for (const path of await f.filesHolding(SENTINEL_MARK)) {
    const text = strip(await Deno.readTextFile(join(f.repoDir, path)));
    assertEquals(
      text.includes(SENTINEL_MARK),
      false,
      `${path} holds a sentinel`,
    );
  }
}

export function write(name = "write"): Step {
  return Step.create({ name, task: StepTask.model("writer", "write", {}) });
}

export function writeClass(cls: string): Step {
  return Step.create({
    name: `w-${cls}`,
    task: StepTask.model("writer", "writeClass", { cls }),
  });
}

export function gate(dependsOn = "write"): Step {
  return Step.create({
    name: "gate",
    task: StepTask.manualApproval("Continue?"),
    dependsOn: after(dependsOn),
  });
}

export const OUTPUT_PASSWORD = "${{ steps.write.outputs.password }}";
export const OUTPUT_HOST = "${{ steps.write.outputs.host }}";

export const byHost = (f: Fixture) =>
  new Map(f.received.map((r) => [r.note, r.password]));
