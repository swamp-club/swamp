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
 * Data spliced into a command/shell `run` reaches the shell through the
 * environment, never as syntax (swamp-club#3868).
 *
 * Runs the real workflow execution path in-process against a temp repo and
 * spawns real `sh` for the command/shell steps. A value from a workflow's
 * caller, a webhook-triggered run's input or an environment read is one
 * literal word to the shell, so shell syntax in it never runs; text the
 * author wrote, including an input's default, keeps the behaviour it always
 * had.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { exists, walk } from "@std/fs";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";
import { initializeTestRepo } from "./test_helpers.ts";

await initializeLogging({});

const SHELL = ModelType.create("command/shell");

/** POSIX `sh` runs these steps; PowerShell placement is unit tested. */
const posix = { ignore: Deno.build.os === "windows" };

interface RunOutcome {
  status?: string;
  errors: string[];
}

async function withRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3868-" });
  try {
    await initializeTestRepo(repoDir);
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Saves a shell definition `name` whose `run` reads `inputs.value`. */
async function saveShell(
  repoDir: string,
  name: string,
  run: string,
  options: { env?: Record<string, string>; defaultValue?: string } = {},
): Promise<void> {
  await new YamlDefinitionRepository(repoDir).save(
    SHELL,
    Definition.create({
      name,
      type: SHELL.normalized,
      inputs: {
        type: "object",
        properties: {
          value: options.defaultValue === undefined
            ? { type: "string" }
            : { type: "string", default: options.defaultValue },
        },
      },
      methods: {
        execute: {
          arguments: {
            run,
            ...(options.env ? { env: options.env } : {}),
          },
        },
      },
    }),
  );
}

/** A workflow whose one step runs `model` with `inputs.value` passed on. */
function workflowFor(
  model: string,
  trigger?: { inputs: Record<string, unknown> },
): Workflow {
  return Workflow.create({
    name: `wf-${crypto.randomUUID()}`,
    inputs: { type: "object", properties: { value: { type: "string" } } },
    ...(trigger ? { trigger } : {}),
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "run",
        task: StepTask.model(model, "execute", {
          value: "${{ inputs.value }}",
        }),
      })],
    })],
  });
}

async function runWorkflow(
  repoDir: string,
  workflow: Workflow,
  options: { inputs?: Record<string, unknown>; triggerSource?: string } = {},
): Promise<RunOutcome> {
  await new YamlWorkflowRepository(repoDir).save(workflow);
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    const service = new WorkflowExecutionService(
      new YamlWorkflowRepository(repoDir),
      new YamlWorkflowRunRepository(repoDir),
      repoDir,
      undefined,
      undefined,
      catalogStore,
    );
    const outcome: RunOutcome = { errors: [] };
    for await (const event of service.run(workflow.name, options)) {
      if (event.kind === "completed") outcome.status = event.run.status;
      if (event.kind === "step_failed" || event.kind === "completed") {
        outcome.errors.push(JSON.stringify(event).slice(0, 2000));
      }
    }
    return outcome;
  } finally {
    catalogStore.close();
  }
}

/**
 * Runs `execute` on the shell definition `model` directly, as
 * `swamp behavior run` does, with `inputs` given as `--input` values. Returns
 * the error events, as text.
 */
async function runDirect(
  repoDir: string,
  model: string,
  inputs: Record<string, unknown>,
  options: { literalInputs?: boolean } = {},
): Promise<string> {
  const repo = createRepositoryContext({ repoDir });
  try {
    const deps = await createModelMethodRunDeps(repoDir, repo);
    const events = await collect(modelMethodRun(createLibSwampContext(), deps, {
      modelIdOrName: model,
      methodName: "execute",
      inputs,
      literalInputs: options.literalInputs,
      lastEvaluated: false,
    }));
    return events.filter((e) => e.kind === "error").map((e) =>
      JSON.stringify(e)
    ).join("\n");
  } finally {
    repo.catalogStore.close();
  }
}

/** The stdout and recorded command of every shell result in the repo. */
async function shellResults(
  repoDir: string,
): Promise<{ stdout: string; command: string }[]> {
  const results: { stdout: string; command: string }[] = [];
  const root = join(repoDir, ".swamp", "data", "command", "shell");
  if (!await exists(root)) return results;
  for await (const entry of walk(root, { includeDirs: false })) {
    if (!entry.path.endsWith("raw")) continue;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(entry.path)) as {
        stdout?: string;
        command?: string;
      };
      if (parsed.stdout !== undefined && parsed.command !== undefined) {
        results.push({ stdout: parsed.stdout, command: parsed.command });
      }
    } catch {
      // not a result file
    }
  }
  return results;
}

Deno.test(
  "shell data splice: a workflow caller's input is one literal word, so syntax in it never runs",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "inj", "echo hello ${{ inputs.value }}");
      const outcome = await runWorkflow(repoDir, workflowFor("inj"), {
        inputs: { value: `x; touch ${marker}` },
      });
      assertEquals(outcome.status, "succeeded", outcome.errors.join("\n"));
      assertEquals(await exists(marker), false, "the injected command ran");
      const [result] = await shellResults(repoDir);
      assertEquals(result.stdout, `hello x; touch ${marker}`);
      assertEquals(result.command, 'echo hello "${__SWAMP_IN_0}"');
    });
  },
);

Deno.test(
  "shell data splice: a webhook-triggered run's input is data even where the trigger maps it",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "hook", "echo title=${{ inputs.value }}");
      // As the webhook route hands the run its inputs: the trigger's
      // template already resolved against the payload.
      const outcome = await runWorkflow(
        repoDir,
        workflowFor("hook", {
          inputs: { value: "${{ webhook.body.pull_request.title }}" },
        }),
        {
          inputs: { value: `$(touch ${marker})` },
          triggerSource: "webhook",
        },
      );
      assertEquals(outcome.status, "succeeded", outcome.errors.join("\n"));
      assertEquals(await exists(marker), false, "the injected command ran");
      const [result] = await shellResults(repoDir);
      assertEquals(result.stdout, `title=$(touch ${marker})`);
    });
  },
);

Deno.test(
  "shell data splice: a value with spaces is one argument, while the author's default keeps splitting",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await saveShell(
        repoDir,
        "words",
        "printf '[%s]' ${{ inputs.value }}",
        { defaultValue: "a b" },
      );
      const caller = await runWorkflow(repoDir, workflowFor("words"), {
        inputs: { value: "c d" },
      });
      assertEquals(caller.status, "succeeded", caller.errors.join("\n"));
      assertEquals((await shellResults(repoDir))[0].stdout, "[c d]");
    });
    await withRepo(async (repoDir) => {
      await saveShell(
        repoDir,
        "words",
        "printf '[%s]' ${{ inputs.value }}",
        { defaultValue: "a b" },
      );
      // A caller value equal to the workflow's own default is that authored
      // text, so it is spliced inline as before.
      const authored = await runWorkflow(
        repoDir,
        Workflow.create({
          name: `wf-${crypto.randomUUID()}`,
          inputs: {
            type: "object",
            properties: { value: { type: "string", default: "a b" } },
          },
          jobs: [Job.create({
            name: "main",
            steps: [Step.create({
              name: "run",
              task: StepTask.model("words", "execute", {
                value: "${{ inputs.value }}",
              }),
            })],
          })],
        }),
        { inputs: { value: "a b" } },
      );
      assertEquals(authored.status, "succeeded", authored.errors.join("\n"));
      assertEquals((await shellResults(repoDir))[0].stdout, "[a][b]");
    });
  },
);

Deno.test(
  "shell data splice: a value passed in env and referenced unquoted still splits into words, and runs nothing",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "flags", "printf '[%s]' $FLAGS", {
        env: { FLAGS: "${{ inputs.value }}" },
      });
      const outcome = await runWorkflow(repoDir, workflowFor("flags"), {
        inputs: { value: `--force --dry-run; touch ${marker}` },
      });
      assertEquals(outcome.status, "succeeded", outcome.errors.join("\n"));
      assertEquals(await exists(marker), false, "the injected command ran");
      const [result] = await shellResults(repoDir);
      assertEquals(
        result.stdout,
        `[--force][--dry-run;][touch][${marker}]`,
      );
    });
  },
);

Deno.test(
  "shell data splice: data inside a quoted here-document is refused and nothing runs",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await saveShell(
        repoDir,
        "doc",
        "cat <<'EOF'\n${{ inputs.value }}\nEOF",
      );
      const outcome = await runWorkflow(repoDir, workflowFor("doc"), {
        inputs: { value: "hi" },
      });
      assertEquals(outcome.status, "failed");
      assertStringIncludes(
        outcome.errors.join("\n"),
        "shell_data_placement_refused",
      );
      assertEquals(await shellResults(repoDir), []);
    });
  },
);

Deno.test(
  "shell data splice: a run that is nothing but data is refused with the env workaround",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await saveShell(repoDir, "whole", "${{ inputs.value }}");
      const outcome = await runWorkflow(repoDir, workflowFor("whole"), {
        inputs: { value: "echo hi" },
      });
      assertEquals(outcome.status, "failed");
      const errors = outcome.errors.join("\n");
      assertStringIncludes(errors, "shell_data_placement_refused");
      assertStringIncludes(errors, "env argument");
    });
  },
);

Deno.test(
  "shell data splice: an environment variable read at run time is data too",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "envread", "echo v=${{ env.SWAMP_3868_VALUE }}");
      await withMockedEnv(
        { SWAMP_3868_VALUE: `a; touch ${marker}` },
        async () => {
          const outcome = await runWorkflow(repoDir, workflowFor("envread"), {
            inputs: { value: "unused" },
          });
          assertEquals(
            outcome.status,
            "succeeded",
            outcome.errors.join("\n"),
          );
        },
      );
      assertEquals(await exists(marker), false, "the injected command ran");
      const [result] = await shellResults(repoDir);
      assertEquals(result.stdout, `v=a; touch ${marker}`);
    });
  },
);

Deno.test(
  "shell data splice: authored text keeps its inline behaviour",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      await saveShell(repoDir, "authored", "printf '[%s]' a b; echo");
      const outcome = await runWorkflow(repoDir, workflowFor("authored"), {
        inputs: { value: "unused" },
      });
      assertEquals(outcome.status, "succeeded", outcome.errors.join("\n"));
      const [result] = await shellResults(repoDir);
      assert(result.stdout.startsWith("[a][b]"), result.stdout);
      assertEquals(result.command, "printf '[%s]' a b; echo");
    });
  },
);

Deno.test(
  "shell data splice: data in shell arithmetic is refused, as bash evaluates it again",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "arith", "echo $(( ${{ inputs.value }} + 1 ))");
      const outcome = await runWorkflow(repoDir, workflowFor("arith"), {
        inputs: { value: `a[$(touch ${marker})]` },
      });
      assertEquals(outcome.status, "failed");
      assertEquals(await exists(marker), false, "the injected command ran");
      const errors = outcome.errors.join("\n");
      assertStringIncludes(errors, "shell_data_placement_refused");
      assertStringIncludes(errors, "shell arithmetic");
    });
  },
);

Deno.test(
  "shell data splice: a run the operator types with --input runs as written, and what it reads at run time is data",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "direct", "echo authored");
      await withMockedEnv(
        { SWAMP_3868_VALUE: `a; touch ${marker}` },
        async () => {
          assertEquals(
            await runDirect(repoDir, "direct", {
              run: "printf '[%s]' a b; echo v=${{ env.SWAMP_3868_VALUE }}",
            }),
            "",
          );
        },
      );
      assertEquals(await exists(marker), false, "the injected command ran");
      const [result] = await shellResults(repoDir);
      assertEquals(result.stdout, `[a][b]v=a; touch ${marker}`);
      assertEquals(
        result.command,
        `printf '[%s]' a b; echo v="\${__SWAMP_IN_0}"`,
      );
    });
  },
);

Deno.test(
  "shell data splice: a run given as a literal input is data, so it is refused whole",
  posix,
  async () => {
    await withRepo(async (repoDir) => {
      const marker = join(repoDir, "PWNED");
      await saveShell(repoDir, "literal", "echo authored");
      const errors = await runDirect(
        repoDir,
        "literal",
        { run: `touch ${marker}` },
        { literalInputs: true },
      );
      assertStringIncludes(errors, "shell_data_placement_refused");
      assertEquals(await exists(marker), false, "the literal run ran");
    });
  },
);
