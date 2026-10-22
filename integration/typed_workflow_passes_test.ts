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
 * Typed secrets in the workflow passes, end to end
 * (design/enablers/typed-secrets.md Sections 3.4, 5 and 7.1, typed-secrets
 * 4.1): guards, asserts, forEach items and identities, child workflow
 * bindings and the model.method consumer path run through a real
 * WorkflowExecutionService on a temp repository, against a vault that
 * answers existence itself and counts every value it hands out, so a load
 * is a load and a check costs nothing. The internal option is turned on by
 * passing the run its sensitive values over a typed registry, as only tests
 * may; every scenario also runs with the option off and asserts today's
 * behavior.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import {
  RunVaultAccess,
  runWithVaultAccess,
} from "../src/domain/vaults/run_vault_access.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import { type Canary, generateCanaries } from "./canary_values.ts";

await initializeLogging({});

const VAULT = "prod";
const TOKEN_KEY = "TOKEN";
const SENTINEL_MARK = "__SWAMP_VSEC_";

interface Received {
  password?: string;
  note?: string;
}

interface Fixture {
  repoDir: string;
  type: string;
  canaries: Canary[];
  /** The value stored under TOKEN_KEY, a canary of its own. */
  token: string;
  /** What the trusted method received, in order. */
  received: Received[];
  /** Every value the vault handed out: a load. */
  loads: string[];
  /** Every existence answer the vault gave: a check that read nothing. */
  checks: string[];
  run: (
    workflow: Workflow,
    typed: boolean,
    extra?: Workflow[],
  ) => Promise<Run>;
  /** Resumes a suspended run, over a typed registry when `typed`. */
  resume: (
    workflowName: string,
    runId: string,
    typed: boolean,
  ) => Promise<Run>;
  /** Approves the run's waiting manual approval in its record. */
  approve: (workflowName: string, runId: string) => Promise<void>;
  /** Saves a workflow, replacing the stored one of the same id. */
  saveWorkflow: (workflow: Workflow) => Promise<void>;
  /** Edits a run's stored record in place. */
  editRun: (
    workflowName: string,
    runId: string,
    edit: (data: Record<string, unknown>) => void,
  ) => Promise<void>;
  /** Called by the write methods once their record is written. */
  hooks: { afterWrite?: () => void };
  /**
   * Writes one tagged record per canary class through a prior run of the
   * real writer, then clears the counters, so a scenario's loads and checks
   * are its own. Expansion and the run-start pass read data before any step
   * runs, so the records must exist before the scenario's run starts.
   */
  seed: () => Promise<void>;
  /** The vault key the record `name` stores its password under. */
  storedKey: (name: string) => Promise<string>;
  /** Files under .swamp holding `value`, or the sentinel mark. */
  filesHolding: (value: string) => Promise<string[]>;
  forbidden: string[];
}

interface Run {
  status?: string;
  runId?: string;
  events: WorkflowExecutionEvent[];
  errors: Map<string, string>;
  skipped: Map<string, unknown>;
  asserts: Map<string, { passed: boolean; message: string }>;
  /** The run record of the completed run, as a JSON text. */
  record: string;
}

const canaryName = (canary: Canary) => `c-${canary.class}`;

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
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
  const hooks: { afterWrite?: () => void } = {};
  const type = ModelType.create(
    `test/typed-passes-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.10.21.1",
    globalArguments: z.object({}),
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
        execute: (args) => {
          received.push({ ...(args as Received) });
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
        const bytes = await Deno.readFile(entry.path);
        if (new TextDecoder("latin1").decode(bytes).includes(value)) {
          found.push(entry.path.slice(repoDir.length));
        }
      }
      return found;
    };
    const workflowRepo = new YamlWorkflowRepository(repoDir);
    const runRepo = new YamlWorkflowRunRepository(repoDir);
    /** What a run or a resume is handed: a typed registry when `typed`. */
    const sensitiveValuesFor = (typed: boolean) => {
      const redactor = new SecretRedactor();
      return {
        secretRedactor: redactor,
        sensitiveValues: typed
          ? new RunSensitiveValues(
            redactor,
            new SecretBagRegistry({ typedSecrets: true }),
          )
          : undefined,
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
        );
        for await (const event of events(service)) {
          result.events.push(event);
          if (event.kind === "started") result.runId = event.runId;
          if (event.kind === "completed") {
            result.status = event.run.status;
            result.record = JSON.stringify(event.run.toData());
          }
          if (event.kind === "suspended") {
            result.status = "suspended";
            result.record = JSON.stringify(event.run.toData());
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
      typed: boolean,
      extra: Workflow[] = [],
    ): Promise<Run> => {
      for (const w of [workflow, ...extra]) await workflowRepo.save(w);
      return await drive((service) =>
        service.run(workflow.name, sensitiveValuesFor(typed))
      );
    };
    const resume = (
      workflowName: string,
      runId: string,
      typed: boolean,
    ): Promise<Run> =>
      drive((service) =>
        service.resume(workflowName, runId, sensitiveValuesFor(typed))
      );
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
        false,
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

const after = (step: string) => [{
  step,
  condition: TriggerCondition.succeeded(),
}];

function seedStep(): Step {
  return Step.create({
    name: "seed",
    task: StepTask.model("writer", "seed", {}),
  });
}

function consume(
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

const quotes = (f: Fixture) =>
  f.canaries.find((c) => c.class === "quotes")!.value;
const PASSWORD_CEL = "data.latest('writer', 'c-quotes').attributes.password";
const PASSWORD = `\${{ ${PASSWORD_CEL} }}`;
const TOKEN = `\${{ vault.get('${VAULT}', '${TOKEN_KEY}') }}`;

/** Every event and the run record hold no canary and no sentinel. */
async function assertNothingLeaked(f: Fixture, run: Run): Promise<void> {
  const events = JSON.stringify(
    run.events.filter((e) =>
      e.kind !== "completed" && e.kind !== "cancelled" && e.kind !== "suspended"
    ),
  );
  for (const value of f.forbidden) {
    assertEquals(events.includes(value), false, `events hold ${value}`);
    assertEquals(run.record.includes(value), false, `record holds ${value}`);
    assertEquals(await f.filesHolding(value), [], `files hold ${value}`);
  }
  assertEquals(events.includes(SENTINEL_MARK), false, "events hold a sentinel");
  assertEquals(
    run.record.includes(SENTINEL_MARK),
    false,
    "record holds a sentinel",
  );
  assertEquals(await f.filesHolding(SENTINEL_MARK), []);
}

Deno.test("typed workflow passes: a guard whose result holds a secret refuses before any load, from a tagged field, a vault.get and a model.method result; with the option off it decides on plaintext", async () => {
  const guards = () =>
    Workflow.create({
      name: "guard-refuses",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("by-data", {}, {
            guard: PASSWORD,
            allowFailure: true,
          }),
          consume("by-vault", {}, { guard: TOKEN, allowFailure: true }),
          consume("by-method", {}, {
            guard: "${{ model.method('writer', 'write', {}).password }}",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(guards(), true);
    // A refused guard fails its step, as any guard failure does, and a
    // failed guard is never an allowed failure, so the run fails.
    assertEquals(run.status, "failed");
    for (const step of ["by-data", "by-vault", "by-method"]) {
      const error = run.errors.get(step);
      assert(error, `${step} should have failed`);
      assertStringIncludes(error, "secret_destination_refused", step);
      assertStringIncludes(error, "guard or assert predicate result", step);
    }
    assertEquals(run.skipped.size, 0);
    assertEquals(f.received, []);
    // No guard loaded: not the tagged field, not the vault key, and the
    // write method's record is kept as stored for its step outputs, so
    // nothing was read back either (typed-secrets 4.2).
    assertEquals(f.loads, []);
    // The vault.get guard cost one existence check, answered by has().
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(guards(), false);
    // Today a tagged field is read eagerly and the guard decides on its
    // plaintext truthiness; a model.method result answers parsed content;
    // and a guard binds no vault, so the vault.get guard fails as an
    // unknown name.
    assertEquals(run.skipped.has("by-data"), true);
    assertEquals(run.skipped.has("by-method"), true);
    assertEquals(run.errors.has("by-vault"), true);
    assert(f.loads.length >= 1);
    assertEquals(f.checks, []);
  });
});

Deno.test("typed workflow passes: a guard comparing a secret to null passes with no load, and a step a guard skips makes no vault read", async () => {
  const workflow = () =>
    Workflow.create({
      name: "guard-skips",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume("skipped", { password: PASSWORD, note: TOKEN }, {
            guard: `\${{ ${PASSWORD_CEL} != null }}`,
          }),
          consume("runs", { password: PASSWORD, note: TOKEN }, {
            guard: `\${{ ${PASSWORD_CEL} == null }}`,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow(), true);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(run.skipped.get("skipped"), true);
    assertEquals(run.errors.size, 0);
    // The skipped step read nothing; the step that ran loaded each of its
    // two references exactly once, at delivery, and received the exact value.
    assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
    assertEquals(f.loads.length, 2);
    assertEquals(f.loads.includes(TOKEN_KEY), true);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow(), false);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(run.skipped.get("skipped"), true);
    assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
    // The option-off path reads the tagged field eagerly in each guard.
    assert(f.loads.length > 2);
  });
});

Deno.test("typed workflow passes: an assert predicate holding a secret is refused, and an assert message holding one is masked in the event, the step error and the run record with zero loads", async () => {
  const seeded = () =>
    Workflow.create({
      name: "asserts",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "predicate",
            task: StepTask.assert(PASSWORD_CEL, "never shown"),
            allowFailure: true,
          }),
          Step.create({
            name: "message",
            task: StepTask.assert(
              "1 == 2",
              `token=${PASSWORD} vault=${TOKEN} plain=${"${{ 'p' }}"}`,
            ),
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(seeded(), true);
    // The refused predicate fails its step and the run; the failed
    // assertion with a masked message is an allowed failure.
    assertEquals(run.status, "failed");
    assertStringIncludes(
      run.errors.get("predicate") ?? "",
      "secret_destination_refused",
    );
    assertEquals(run.asserts.get("message"), {
      passed: false,
      message: "token=*** vault=*** plain=p",
    });
    assertEquals(run.errors.get("message"), "token=*** vault=*** plain=p");
    assertEquals(f.loads, []);
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(seeded(), false);
    // Today the predicate decides on plaintext truthiness, and the message
    // loads both values and the redactor masks them.
    assertEquals(run.asserts.get("predicate")?.passed, true);
    assertEquals(
      run.asserts.get("message")?.message,
      "token=*** vault=*** plain=p",
    );
    assert(f.loads.length >= 2);
    await assertNothingLeaked(f, run);
  });
});

Deno.test("typed workflow passes: forEach over tagged records binds each item as a Secret, names its steps sensitive-<index>, and delivers the exact canary of every class with one load per iteration", async () => {
  const workflow = () =>
    Workflow.create({
      name: "for-each",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume(
            "use-${{ self.c.attributes.password }}-${{ self.c.attributes.host }}",
            {
              password: "${{ self.c.attributes.password }}",
              note: "${{ self.c.attributes.host }}",
            },
            {
              forEach: {
                item: "c",
                in: "${{ data.findBySpec('writer', 'creds') }}",
              },
            },
          ),
          consume("compare-${{ self.c.attributes.host }}", {}, {
            forEach: {
              item: "c",
              in: "${{ data.findBySpec('writer', 'creds') }}",
            },
            guard: "${{ self.c.attributes.password == 'x' }}",
            allowFailure: true,
          }),
        ],
      })],
    });
  const expectedNames = (f: Fixture) =>
    f.canaries.map((_, index) => `use-sensitive-${index}-`);
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow(), true);
    // The refused comparisons fail their steps and the run; every delivery
    // step completed.
    assertEquals(run.status, "failed");
    const byHost = new Map(f.received.map((r) => [r.note, r.password]));
    for (const canary of f.canaries) {
      assertEquals(
        byHost.get(canary.class),
        canary.value,
        `typed: ${canary.class}`,
      );
    }
    assertEquals(f.received.length, f.canaries.length);
    assertEquals(f.loads.length, f.canaries.length);
    const names = run.events.flatMap((e) =>
      e.kind === "step_completed" && e.stepId.startsWith("use-")
        ? [e.stepId]
        : []
    ).sort();
    assertEquals(names.length, f.canaries.length);
    for (const [index, name] of names.entries()) {
      assert(
        expectedNames(f).some((prefix) => name.startsWith(prefix)),
        `${index}: ${name}`,
      );
      assertEquals(name.includes(SENTINEL_MARK), false, name);
    }
    // The item binds as a Secret in the guard: the comparison is refused.
    const compared = [...run.errors].filter(([step]) =>
      step.startsWith("compare-")
    );
    assertEquals(compared.length, f.canaries.length);
    for (const [, error] of compared) {
      assertStringIncludes(error, "secret_operation_unsupported");
    }
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow(), false);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    const byHost = new Map(f.received.map((r) => [r.note, r.password]));
    // Today a tagged field of a findBySpec record is the stored reference
    // text (design Section 10.1), delivered as text with no load; the typed
    // path above delivers every class exactly.
    for (const canary of f.canaries) {
      assertStringIncludes(
        byHost.get(canary.class) ?? "",
        "vault.get('prod', '",
        `untyped: ${canary.class}`,
      );
    }
    assertEquals(f.loads, []);
    // No value reached a name: none was read.
    const names = run.events.flatMap((e) =>
      e.kind === "step_completed" && e.stepId.startsWith("use-")
        ? [e.stepId]
        : []
    );
    for (const canary of f.canaries.filter((c) => c.unique)) {
      assertEquals(names.some((n) => n.includes(canary.value)), false);
    }
    // The guard compares reference text today, so no iteration is refused.
    assertEquals(run.errors.size, 0);
  });
});

Deno.test("typed workflow passes: a child workflow binds a parent sentinel as a Secret, issues its own sentinel for a deferred vault.get input, and delivers each once", async () => {
  const child = () =>
    Workflow.create({
      name: "child-wf",
      inputs: {
        properties: {
          token: { type: "string" },
          viaVault: { type: "string" },
        },
      },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "compare",
            task: StepTask.model("writer", "consume", {}),
            guard: "${{ inputs.token == 'x' }}",
            allowFailure: true,
          }),
          Step.create({
            name: "deliver",
            task: StepTask.model("writer", "consume", {
              password: "${{ inputs.token }}",
              note: "${{ inputs.viaVault }}",
            }),
          }),
        ],
      })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-wf",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-wf", {
              token: PASSWORD,
              viaVault: TOKEN,
            }),
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(parent(), true, [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertStringIncludes(
      run.errors.get("compare") ?? "",
      "secret_operation_unsupported",
    );
    assertEquals(f.received, [{ password: quotes(f), note: f.token }]);
    assertEquals(f.loads.length, 2);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(parent(), false, [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    // Today the parent's sentinel is text in the child's guard, so the
    // comparison is simply false and the step runs.
    assertEquals(run.errors.has("compare"), false);
    assertEquals(f.received.at(-1), { password: quotes(f), note: f.token });
  });
});

Deno.test("typed workflow passes: a step name resolved at run start keeps the sensitive-<vault>.<key> stand-in, for a plain step and for the forEach template its iterations are recorded under", async () => {
  // Both names read a secret but no `self`, so the run-start pass resolves
  // them: the forEach template is the identity every iteration's events and
  // run record carry (`forEachTemplate`), and the plain name is a step's.
  const workflow = () =>
    Workflow.create({
      name: "name-stand-in",
      jobs: [Job.create({
        name: "main",
        steps: [
          consume(`p-${PASSWORD}`, { note: "${{ self.c.attributes.host }}" }, {
            forEach: {
              item: "c",
              in: "${{ data.findBySpec('writer', 'creds') }}",
            },
          }),
          consume(`q-${PASSWORD}`, { note: "plain" }),
        ],
      })],
    });
  const templatesOf = (run: Run) =>
    new Set(
      run.events.flatMap((e) =>
        e.kind === "step_started" && e.forEachTemplate !== undefined
          ? [e.forEachTemplate]
          : []
      ),
    );
  const plainNamesOf = (run: Run) =>
    run.events.flatMap((e) =>
      e.kind === "step_started" && e.stepId.startsWith("q-") ? [e.stepId] : []
    );
  await withFixture(async (f) => {
    await f.seed();
    const key = await f.storedKey("c-quotes");
    const standIn = `sensitive-${VAULT}.${
      encodeURIComponent(key).replaceAll(".", "%2E")
    }`;
    const run = await f.run(workflow(), true);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals([...templatesOf(run)], [`p-${standIn}`]);
    assertEquals(plainNamesOf(run), [`q-${standIn}`]);
    assertEquals(f.received.length, f.canaries.length + 1);
    // The stand-in is taken from the sentinel: nothing is read for a name.
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    await f.seed();
    const run = await f.run(workflow(), false);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(templatesOf(run).size, 1);
    assertEquals(plainNamesOf(run).length, 1);
    await assertNothingLeaked(f, run);
  });
});

function write(name = "write"): Step {
  return Step.create({ name, task: StepTask.model("writer", "write", {}) });
}

function writeClass(cls: string): Step {
  return Step.create({
    name: `w-${cls}`,
    task: StepTask.model("writer", "writeClass", { cls }),
  });
}

function gate(dependsOn = "write"): Step {
  return Step.create({
    name: "gate",
    task: StepTask.manualApproval("Continue?"),
    dependsOn: after(dependsOn),
  });
}

const OUTPUT_PASSWORD = "${{ steps.write.outputs.password }}";
const OUTPUT_HOST = "${{ steps.write.outputs.host }}";

const byHost = (f: Fixture) =>
  new Map(f.received.map((r) => [r.note, r.password]));

Deno.test("typed workflow passes: a later step reads steps.<name>.outputs through the adapter, so every canary class is delivered exactly with one load each at delivery and none before, a plain sibling stays text, and a guard comparing the tagged field refuses; with the option off the outputs are read eagerly (typed-secrets 4.2)", async () => {
  const workflow = (f: Fixture) =>
    Workflow.create({
      name: "live-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          ...f.canaries.flatMap((c) => [
            writeClass(c.class),
            consume(`u-${c.class}`, {
              password: `\${{ steps['w-${c.class}'].outputs.password }}`,
              note: `\${{ steps['w-${c.class}'].outputs.host }}`,
            }, { dependsOn: `w-${c.class}` }),
          ]),
          consume("compare", {}, {
            guard: "${{ steps['w-quotes'].outputs.password == 'x' }}",
            dependsOn: "w-quotes",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(workflow(f), true);
    // The refused guard fails its step and the run; every delivery ran.
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["compare"]);
    assertStringIncludes(
      run.errors.get("compare")!,
      "secret_operation_unsupported",
    );
    const delivered = byHost(f);
    for (const canary of f.canaries) {
      assertEquals(
        delivered.get(canary.class),
        canary.value,
        `typed: ${canary.class}`,
      );
    }
    assertEquals(f.received.length, f.canaries.length);
    // One load per delivery: the write steps read nothing back, the guard
    // loaded nothing, and a data-origin reference is never probed.
    assertEquals(f.loads.length, f.canaries.length);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    const run = await f.run(workflow(f), false);
    // Today the completing write step resolves its record eagerly, the
    // guard compares the plaintext and is false, so the guarded step runs
    // too, and the deliveries match.
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(run.skipped.size, 0);
    assertEquals(f.received.length, f.canaries.length + 1);
    const delivered = byHost(f);
    for (const canary of f.canaries) {
      assertEquals(
        delivered.get(canary.class),
        canary.value,
        `untyped: ${canary.class}`,
      );
    }
    assert(f.loads.length >= f.canaries.length);
  });
});

Deno.test("typed workflow passes: a step output whose vault the run's access refuses fails the step that reads any field of the record before the result is used, with zero loads; with the option off the eager read-back is refused instead (typed-secrets 4.2)", async () => {
  const workflow = () =>
    Workflow.create({
      name: "denied-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          consume("use", { note: OUTPUT_HOST }, { dependsOn: "write" }),
        ],
      })],
    });
  // A principal policy that lets the record be written, then refuses every
  // read of the vault: the vaults list cannot do this, since it is run-wide.
  const readsRefusedAfterWrite = (f: Fixture): RunVaultAccess => {
    let denyReads = false;
    f.hooks.afterWrite = () => {
      denyReads = true;
    };
    return RunVaultAccess.create({
      policy: {
        principal: "user:tester",
        decide: (_vault, action) => ({
          allowed: !(denyReads && action === "read"),
          reason: denyReads && action === "read"
            ? "reads are refused once the record is written"
            : "allowed",
        }),
      },
    });
  };
  await withFixture(async (f) => {
    const run = await runWithVaultAccess(
      readsRefusedAfterWrite(f),
      () => f.run(workflow(), true),
    );
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["use"]);
    assertStringIncludes(run.errors.get("use")!, "refused");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    const run = await runWithVaultAccess(
      readsRefusedAfterWrite(f),
      () => f.run(workflow(), false),
    );
    // Today the record is resolved eagerly when the write step completes,
    // and the refusal lands there.
    assertEquals(run.status, "failed");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
  });
});

Deno.test("typed workflow passes: outputs reconstructed from the run record on resume read through the adapter: the resumed step delivers the exact canary with one load and no read at resume, a vaults list narrowed before the resume refuses the read before use, and a tag the writer could not have stored refuses with secret_reference_invalid; with the option off the resume reads the outputs eagerly (typed-secrets 4.2)", async () => {
  const NAME = "resume-outputs";
  const workflow = () =>
    Workflow.create({
      name: NAME,
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          gate(),
          consume("use", { password: OUTPUT_PASSWORD, note: OUTPUT_HOST }, {
            dependsOn: "gate",
          }),
        ],
      })],
    });
  /** Runs to the approval, approves it in the record, and hands back the ids. */
  const suspend = async (
    f: Fixture,
    typed: boolean,
  ): Promise<{ runId: string; workflow: Workflow }> => {
    const wf = workflow();
    const run = await f.run(wf, typed);
    assertEquals(run.status, "suspended", [...run.errors].join("\n"));
    assert(run.runId);
    await f.approve(NAME, run.runId);
    return { runId: run.runId, workflow: wf };
  };
  await withFixture(async (f) => {
    const { runId } = await suspend(f, true);
    assertEquals(f.loads, []);
    const resumed = await f.resume(NAME, runId, true);
    assertEquals(resumed.status, "succeeded", [...resumed.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    // The resume read the record back as stored; the one load is the
    // delivery's.
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, resumed);
  });
  await withFixture(async (f) => {
    const { runId, workflow: wf } = await suspend(f, true);
    // An edit to the workflow narrows a suspended run (resumeVaultAccess).
    await f.saveWorkflow(
      Workflow.fromData(
        { ...wf.toData(), vaults: ["other"] } as Parameters<
          typeof Workflow.fromData
        >[0],
      ),
    );
    const resumed = await f.resume(NAME, runId, true);
    assertEquals(resumed.status, "failed");
    assertEquals([...resumed.errors.keys()], ["use"]);
    assertStringIncludes(resumed.errors.get("use")!, "refused");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
  });
  await withFixture(async (f) => {
    const { runId } = await suspend(f, true);
    // The run record's tag names a plain field, which the writer could not
    // have stored: the resumed read refuses, naming no value.
    await f.editRun(NAME, runId, (data) => {
      const jobs = data.jobs as Array<{
        steps: Array<{
          stepName: string;
          output?: {
            type?: string;
            resources?: Record<
              string,
              Record<string, { tags: Record<string, string> }>
            >;
          };
        }>;
      }>;
      let tagged = 0;
      for (const job of jobs) {
        for (const step of job.steps) {
          if (step.output?.type !== "model_method") continue;
          for (const instances of Object.values(step.output.resources ?? {})) {
            for (const record of Object.values(instances)) {
              record.tags["_swamp.sensitiveFields"] = JSON.stringify([
                "host",
              ]);
              tagged++;
            }
          }
        }
      }
      assertEquals(tagged, 1);
    });
    const resumed = await f.resume(NAME, runId, true);
    assertEquals(resumed.status, "failed");
    assertEquals([...resumed.errors.keys()], ["use"]);
    assertStringIncludes(
      resumed.errors.get("use")!,
      "secret_reference_invalid",
    );
    assertStringIncludes(resumed.errors.get("use")!, "(steps.write.outputs)");
    assertEquals(f.received, []);
    assertEquals(f.loads, []);
    await assertNothingLeaked(f, resumed);
  });
  await withFixture(async (f) => {
    const { runId } = await suspend(f, false);
    const resumed = await f.resume(NAME, runId, false);
    assertEquals(resumed.status, "succeeded", [...resumed.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assert(f.loads.length >= 1);
  });
});

Deno.test("typed workflow passes: a parent reads a child workflow's outputs through the adapter, so the tagged field is delivered exactly with one load and a guard comparing it refuses; with the option off it is read eagerly (typed-secrets 4.2)", async () => {
  const child = () =>
    Workflow.create({
      name: "child-outputs",
      jobs: [Job.create({ name: "main", steps: [write()] })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-outputs",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-outputs", {}),
          }),
          consume("use", {
            password: "${{ steps.call.outputs.write.password }}",
            note: "${{ steps.call.outputs.write.host }}",
          }, { dependsOn: "call" }),
          consume("compare", {}, {
            guard: "${{ steps.call.outputs.write.password == 'x' }}",
            dependsOn: "call",
            allowFailure: true,
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(parent(), true, [child()]);
    assertEquals(run.status, "failed");
    assertEquals([...run.errors.keys()], ["compare"]);
    assertStringIncludes(
      run.errors.get("compare")!,
      "secret_operation_unsupported",
    );
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    const run = await f.run(parent(), false, [child()]);
    // Today the outputs are read eagerly, the guard compares the plaintext
    // and is false, so the guarded step runs too.
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(run.skipped.size, 0);
    assertEquals(f.received.length, 2);
    assertEquals(
      f.received.filter((r) => r.password !== undefined),
      [{ password: quotes(f), note: "main" }],
    );
    assert(f.loads.length >= 1);
  });
});

Deno.test("typed workflow passes: a child input deferred from the parent that joins a vault.get with a parent step's tagged output delivers both once, the parent's outputs viewed through their persisted sources; with the option off the captured plaintext is delivered (typed-secrets 4.2)", async () => {
  const child = () =>
    Workflow.create({
      name: "child-deferred",
      inputs: { properties: { combo: { type: "string" } } },
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deliver",
            task: StepTask.model("writer", "consume", {
              password: "${{ inputs.combo }}",
            }),
          }),
        ],
      })],
    });
  const parent = () =>
    Workflow.create({
      name: "parent-deferred",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          Step.create({
            name: "call",
            task: StepTask.workflow("child-deferred", {
              combo: `\${{ vault.get('${VAULT}', '${TOKEN_KEY}') + ':' + ` +
                "steps.write.outputs.password }}",
            }),
            dependsOn: after("write"),
          }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(parent(), true, [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: `${f.token}:${quotes(f)}` }]);
    // One load each at the child's delivery; the vault.get cost one
    // existence check, the data-origin reference none.
    assertEquals(f.loads.length, 2);
    assertEquals(f.checks, [TOKEN_KEY]);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    const run = await f.run(parent(), false, [child()]);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: `${f.token}:${quotes(f)}` }]);
  });
});

Deno.test("typed workflow passes: model.<name>.resource of a record a step wrote earlier in the run reads as a Secret through the model map view and is delivered once, instead of refusing; with the option off it holds plaintext (typed-secrets 4.2)", async () => {
  const workflow = () =>
    Workflow.create({
      name: "model-map-live",
      jobs: [Job.create({
        name: "main",
        steps: [
          write(),
          consume("use", {
            password:
              "${{ model.writer.resource.creds.main.attributes.password }}",
            note: "${{ model.writer.resource.creds.main.attributes.host }}",
          }, { dependsOn: "write" }),
        ],
      })],
    });
  await withFixture(async (f) => {
    const run = await f.run(workflow(), true);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assertEquals(f.loads.length, 1);
    assertEquals(f.checks, []);
    await assertNothingLeaked(f, run);
  });
  await withFixture(async (f) => {
    const run = await f.run(workflow(), false);
    assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
    assertEquals(f.received, [{ password: quotes(f), note: "main" }]);
    assert(f.loads.length >= 1);
  });
});

Deno.test("typed workflow passes: a child step name repeated across jobs: the parent reads the later job's outputs, with the option on and off (typed-secrets 4.2)", async () => {
  const classes = (f: Fixture) =>
    f.canaries.filter((c) => c.unique).slice(0, 2).map((c) => c.class);
  const child = (f: Fixture) => {
    const [first, second] = classes(f);
    return Workflow.create({
      name: "child-repeat",
      jobs: [
        Job.create({
          name: "a",
          steps: [Step.create({
            name: "w",
            task: StepTask.model("writer", "writeClass", { cls: first }),
          })],
        }),
        Job.create({
          name: "b",
          dependsOn: [{ job: "a", condition: TriggerCondition.succeeded() }],
          steps: [Step.create({
            name: "w",
            task: StepTask.model("writer", "writeClass", { cls: second }),
          })],
        }),
      ],
    });
  };
  const parent = () =>
    Workflow.create({
      name: "parent-repeat",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.workflow("child-repeat", {}),
          }),
          consume("use", {
            password: "${{ steps.call.outputs.w.password }}",
            note: "${{ steps.call.outputs.w.host }}",
          }, { dependsOn: "call" }),
        ],
      })],
    });
  for (const typed of [true, false]) {
    await withFixture(async (f) => {
      const [, second] = classes(f);
      const run = await f.run(parent(), typed, [child(f)]);
      assertEquals(run.status, "succeeded", [...run.errors].join("\n"));
      const expected = f.canaries.find((c) => c.class === second)!;
      assertEquals(f.received, [{ password: expected.value, note: second }]);
      if (typed) {
        assertEquals(f.loads.length, 1);
        await assertNothingLeaked(f, run);
      }
    });
  }
});
