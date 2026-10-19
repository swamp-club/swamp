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

// One sentinel registry per run (typed-secrets Section 3.2,
// swamp-club#3558): a sentinel the run-start pass issues resolves from any
// later step's bag of that run, and from a child workflow's bags after its
// own rehoming, with the persisted form derived from the registry's entries.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
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
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { RunSensitiveValues } from "../src/domain/secrets/run_sensitive_values.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import { vaultReferenceText } from "../src/domain/secrets/run_sensitive_values.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import {
  holdsValue,
  isIssuedEntry,
  SENTINEL_EXACT,
} from "../src/domain/vaults/secret_bag_registry.ts";
import { initializeTestRepo } from "./test_helpers.ts";

await initializeLogging({});

const SECRET = "Pl41nT3xt-S3cr3t-3558";
const TOKEN = "data.latest('writer', 'main').attributes.token";
const posix = { ignore: Deno.build.os === "windows" };

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3558-" });
  try {
    await initializeTestRepo(repoDir);
    await new YamlVaultConfigRepository(repoDir).save(
      VaultConfig.create(crypto.randomUUID(), "secrets", "local_encryption", {
        auto_generate: true,
        base_dir: repoDir,
      }),
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Registers a per-run model type whose `write` method stores a sensitive token. */
function registerWriter(): ModelType {
  const type = ModelType.create(`test/secret-writer-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.16.1",
    globalArguments: z.object({}),
    resources: {
      creds: {
        description: "Credentials",
        schema: z.object({
          name: z.string(),
          token: z.string().meta({ sensitive: true }),
        }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    methods: {
      write: {
        description: "Writes a sensitive token",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const handle = await context.writeResource!("creds", "main", {
            name: "app",
            token: SECRET,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  });
  return type;
}

/**
 * A step running a saved shell behavior that prints `<LABEL>_OK` when `word`
 * expands to the secret, checked by length and prefix so the secret itself
 * is never authored text. The command is a task input, so the run-start
 * pass evaluates it and the overlay carries its sentinels.
 */
async function checkStep(
  repoDir: string,
  name: string,
  word: string,
  label: string,
  dependsOn?: string,
): Promise<Step> {
  const run = `echo STEP=${name}; v=${word}; [ \${#v} -eq ${SECRET.length} ]` +
    ` && case "$v" in ${SECRET.slice(0, 5)}*) echo ${label}_OK;; esac`;
  const shellType = ModelType.create("command/shell");
  await new YamlDefinitionRepository(repoDir).save(
    shellType,
    Definition.create({
      name: `${name}-shell`,
      type: shellType.normalized,
      methods: { execute: { arguments: { run: "true" } } },
    }),
  );
  return Step.create({
    name,
    task: StepTask.model(`${name}-shell`, "execute", { run }),
    ...(dependsOn
      ? {
        dependsOn: [{
          step: dependsOn,
          condition: TriggerCondition.succeeded(),
        }],
      }
      : {}),
  });
}

/** Runs `workflow` in process with the given run record, and returns its status. */
async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  values?: RunSensitiveValues,
  redactor?: SecretRedactor,
): Promise<string | undefined> {
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    const service = new WorkflowExecutionService(
      new YamlWorkflowRepository(repoDir),
      new YamlWorkflowRunRepository(repoDir),
      repoDir,
      undefined,
      join(repoDir, ".swamp", "data"),
      catalogStore,
    );
    let status: string | undefined;
    const failures: string[] = [];
    for await (
      const event of service.run(workflow.name, {
        sensitiveValues: values,
        secretRedactor: redactor,
      })
    ) {
      if (event.kind === "completed") status = event.run.status;
      if (event.kind === "step_failed") {
        failures.push(JSON.stringify(event).slice(0, 1200));
      }
    }
    assertEquals(status, "succeeded", failures.join("\n"));
    return status;
  } finally {
    catalogStore.close();
  }
}

/** The persisted stdout of every shell result whose text names `step`. */
async function shellStdout(repoDir: string, step: string): Promise<string> {
  const outputs: string[] = [];
  for await (
    const entry of walk(join(repoDir, ".swamp", "data", "command", "shell"), {
      includeDirs: false,
    })
  ) {
    if (!entry.path.endsWith("raw")) continue;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(entry.path)) as {
        stdout?: string;
      };
      if (parsed.stdout?.includes(`STEP=${step}`)) outputs.push(parsed.stdout);
    } catch {
      // not a result file
    }
  }
  return outputs.join("\n");
}

/** Writes the sensitive record a consumer workflow reads at run start. */
async function writeRecord(repoDir: string): Promise<void> {
  const type = registerWriter();
  await new YamlDefinitionRepository(repoDir).save(
    type,
    Definition.create({ name: "writer", type: type.normalized }),
  );
  const writer = Workflow.create({
    name: "writer-flow",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "write",
        task: StepTask.model("writer", "write"),
      })],
    })],
  });
  await new YamlWorkflowRepository(repoDir).save(writer);
  assertEquals(await runWorkflow(repoDir, writer), "succeeded");
}

/** The distinct prefixes of the sentinels a registry holds. */
function prefixesOf(values: RunSensitiveValues): Set<string> {
  return new Set(
    [...values.sentinels.all()].map((entry) => {
      assert(SENTINEL_EXACT.test(entry.sentinel));
      return entry.sentinel.split("_")[4];
    }),
  );
}

Deno.test(
  "secret bag registry: a sentinel the run-start pass issued resolves from every later step's bag, and the cache is written from its entries",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await writeRecord(repoDir);
      // The value crosses into the child as a workflow input, so the child's
      // run-start pass evaluates `inputs.token` for both steps and issues
      // one sentinel for it into the workflow bag; each step rehomes it.
      // (A data read in a task input is deferred to the step pass.)
      const child = Workflow.create({
        name: "consumer-flow",
        inputs: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
        },
        jobs: [Job.create({
          name: "main",
          steps: [
            await checkStep(repoDir, "first", "'${{ inputs.token }}'", "FIRST"),
            await checkStep(
              repoDir,
              "second",
              "'${{ inputs.token }}'",
              "SECOND",
              "first",
            ),
          ],
        })],
      });
      const parent = Workflow.create({
        name: "parent-flow",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "call",
            task: StepTask.workflow(child.name, {
              token: `\${{ ${TOKEN} }}`,
            }),
          })],
        })],
      });
      const workflows = new YamlWorkflowRepository(repoDir);
      await workflows.save(child);
      await workflows.save(parent);
      const redactor = new SecretRedactor();
      const values = new RunSensitiveValues(redactor);

      assertEquals(
        await runWorkflow(repoDir, parent, values, redactor),
        "succeeded",
      );
      assertStringIncludes(await shellStdout(repoDir, "first"), "FIRST_OK");
      assertStringIncludes(await shellStdout(repoDir, "second"), "SECOND_OK");

      // The child's workflow bag and each child step's bag issued under
      // prefixes of their own, into one registry, every entry the same
      // secret from the same reference. The parent's call step issues none:
      // a workflow task's inputs cross as values until Phase 4.
      const entries = [...values.sentinels.all()];
      assertEquals(
        entries.length,
        3,
        JSON.stringify(entries.map((e) => e.sentinel)),
      );
      assertEquals(prefixesOf(values).size, 3);
      for (const entry of entries) {
        assert(isIssuedEntry(entry));
        assertEquals(holdsValue(entry) && entry.value, SECRET);
        assertEquals(entry.dataOrigin, true);
        assertEquals(entry.encoding, "raw");
        assertEquals(values.sourceOf(SECRET), entry.reference);
      }
      // A bag of a later pass resolves any sentinel the run issued, with no
      // rehoming.
      const later = new VaultSecretBag(values.sentinels);
      assertEquals(later.isEmpty, true);
      for (const entry of entries) {
        assertEquals(later.resolveRaw(`<${entry.sentinel}>`), `<${SECRET}>`);
      }

      // The child's evaluated-workflow cache holds the entries' references,
      // derived from the sentinels the overlay carries, never the value.
      const cached = await new YamlEvaluatedWorkflowRepository(repoDir)
        .findByNameWithProvenance(child.name);
      assert(cached);
      const reference = vaultReferenceText(values.sourceOf(SECRET)!);
      const stepArgs = cached.workflow.jobs[0].steps.map((step) =>
        JSON.stringify(step.task.data)
      );
      assertEquals(stepArgs.length, 2);
      for (const args of stepArgs) {
        assertStringIncludes(args, reference);
        assertEquals(args.includes(SECRET), false);
        assertEquals(VaultSecretBag.SENTINEL_PATTERN.test(args), false);
      }
      assertEquals(cached.writtenReferences.length, 2);
      for (const written of cached.writtenReferences) {
        assertEquals(written.dataOrigin, true);
        assertEquals(written.encoding, "raw");
        assertEquals(
          { vaultName: written.vaultName, key: written.key },
          values.sourceOf(SECRET),
        );
      }
    });
  },
);

Deno.test(
  "secret bag registry: a child workflow issues into its parent's registry and delivers through its own rehoming",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await writeRecord(repoDir);
      const child = Workflow.create({
        name: "child-flow",
        inputs: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
        },
        jobs: [Job.create({
          name: "main",
          steps: [
            await checkStep(repoDir, "child", "'${{ inputs.token }}'", "CHILD"),
          ],
        })],
      });
      const parent = Workflow.create({
        name: "parent-flow",
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "call",
            task: StepTask.workflow(child.name, {
              token: `\${{ ${TOKEN} }}`,
            }),
          })],
        })],
      });
      const workflows = new YamlWorkflowRepository(repoDir);
      await workflows.save(child);
      await workflows.save(parent);
      const redactor = new SecretRedactor();
      const values = new RunSensitiveValues(redactor);

      assertEquals(
        await runWorkflow(repoDir, parent, values, redactor),
        "succeeded",
      );
      const stdout = await shellStdout(repoDir, "child");
      assertStringIncludes(stdout, "CHILD_OK");
      assertEquals(VaultSecretBag.SENTINEL_PATTERN.test(stdout), false);

      // The child's workflow bag and step bag drew prefixes of their own in
      // the parent's registry, and every entry resolves from any view of it.
      // The child's workflow bag and its step's bag.
      const entries = [...values.sentinels.all()];
      assertEquals(
        entries.length,
        2,
        JSON.stringify(entries.map((e) => e.sentinel)),
      );
      assertEquals(prefixesOf(values).size, 2);
      const view = new VaultSecretBag(values.sentinels);
      for (const entry of entries) {
        assert(isIssuedEntry(entry));
        assertEquals(entry.dataOrigin, true);
        assertEquals(view.resolveRaw(entry.sentinel), SECRET);
      }
    });
  },
);
