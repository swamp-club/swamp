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
    const run = async (
      workflow: Workflow,
      typed: boolean,
      extra: Workflow[] = [],
    ): Promise<Run> => {
      const workflowRepo = new YamlWorkflowRepository(repoDir);
      for (const w of [workflow, ...extra]) await workflowRepo.save(w);
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
          new YamlWorkflowRunRepository(repoDir),
          repoDir,
          undefined,
          undefined,
          catalog,
        );
        const redactor = new SecretRedactor();
        const sensitiveValues = typed
          ? new RunSensitiveValues(
            redactor,
            new SecretBagRegistry({ typedSecrets: true }),
          )
          : undefined;
        for await (
          const event of service.run(workflow.name, {
            secretRedactor: redactor,
            sensitiveValues,
          })
        ) {
          result.events.push(event);
          if (event.kind === "started") result.runId = event.runId;
          if (event.kind === "completed") {
            result.status = event.run.status;
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
    // No guard loaded: not the tagged field, not the vault key. The one
    // load is the write method's own, reading back the record it wrote for
    // its step outputs, which stay on the eager read until the outputs
    // slice adapts them.
    const quotesKey = await f.storedKey("c-quotes");
    assertEquals(f.loads.includes(TOKEN_KEY), false);
    assertEquals(f.loads.includes(quotesKey), false);
    assert(f.loads.length <= 1, f.loads.join(","));
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
