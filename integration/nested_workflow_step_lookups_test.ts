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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { WorkflowExecutionEvent } from "../src/domain/workflows/execution_events.ts";
import { WorkflowExecutionService } from "../src/domain/workflows/execution_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowValidateDeps,
  workflowValidate,
  type WorkflowValidateEvent,
} from "../src/libswamp/workflows/validate.ts";
import { initializeTestRepo } from "./test_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const RESERVED = { "_swamp.sensitiveFields": JSON.stringify(["stdout"]) };
const REFUSAL =
  "Tag '_swamp.sensitiveFields' from the tags of behavior definition 'tagged' is reserved: tag keys starting with '_swamp.' are written by swamp alone. Remove it.";
// A file mode cannot deny root, or anyone on Windows, a read.
const CANNOT_LOCK = Deno.build.os === "windows" || Deno.uid() === 0;

interface Harness {
  dir: string;
  // `first` sorts before `last` in a definition walk
  first: ModelType;
  last: ModelType;
  executions: string[];
  define(
    name: string,
    options?: { tags?: Record<string, string>; type?: ModelType },
  ): Promise<Definition>;
  save(...workflows: Workflow[]): Promise<void>;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-nested-lookups-" });
  const run = crypto.randomUUID();
  const first = ModelType.create(`@test/a-nested-${run}`);
  const last = ModelType.create(`@test/z-nested-${run}`);
  const executions: string[] = [];
  for (const type of [first, last]) {
    modelRegistry.register({
      type,
      version: "2026.11.19.1",
      globalArguments: z.object({ label: z.string().optional() }),
      resources: {},
      methods: {
        run: {
          description: "run",
          arguments: z.object({}),
          execute: (_args, context) => {
            executions.push(String(context.globalArgs.label));
            return Promise.resolve({ dataHandles: [] });
          },
        },
      },
    });
  }
  const definitions = new YamlDefinitionRepository(dir);
  try {
    await initializeTestRepo(dir);
    await fn({
      dir,
      first,
      last,
      executions,
      define: async (name, options = {}) => {
        const type = options.type ?? first;
        const definition = Definition.create({
          name,
          type: type.normalized,
          globalArguments: { label: `${name}@${type === first ? "a" : "z"}` },
          tags: options.tags ?? {},
          methods: { run: { arguments: {} } },
        });
        await definitions.save(type, definition);
        return definition;
      },
      save: async (...workflows) => {
        const repo = createRepositoryContext({ repoDir: dir });
        try {
          for (const w of workflows) await repo.workflowRepo.save(w);
        } finally {
          repo.catalogStore.close();
        }
      },
    });
  } finally {
    modelRegistry.invalidateType(first);
    modelRegistry.invalidateType(last);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function workflow(
  name: string,
  steps: Step[],
  inputs?: Record<string, unknown>,
): Workflow {
  return Workflow.create({
    name,
    ...(inputs ? { inputs } : {}),
    jobs: [Job.create({ name: "main", steps })],
  });
}

function behaviorStep(name: string): Step {
  return Step.create({
    name: `run-${name}`,
    task: StepTask.model(name, "run"),
  });
}

function callStep(ref: string): Step {
  return Step.create({ name: "call", task: StepTask.workflow(ref) });
}

// sorted after every definition, so a walk for a name it never finds reaches it
async function lockedDefinition(dir: string): Promise<string> {
  const lockedDir = join(dir, "models", "zzzz");
  await ensureDir(lockedDir);
  const path = join(lockedDir, "locked.yaml");
  await Deno.writeTextFile(path, "name: locked\n");
  await Deno.chmod(path, 0o000);
  return path;
}

interface Check {
  name: string;
  passed: boolean;
  error?: string;
}

interface ValidateOutcome {
  thrown?: string;
  error?: string;
  checks?: Check[];
}

// a fresh repository context each call, so no name hint carries over
async function validate(dir: string, name: string): Promise<ValidateOutcome> {
  const repo = createRepositoryContext({ repoDir: dir });
  try {
    const deps = createWorkflowValidateDeps(
      repo.workflowRepo,
      new YamlDefinitionRepository(dir),
      join(dir, "workflows"),
    );
    const events = await collect<WorkflowValidateEvent>(
      workflowValidate(createLibSwampContext(), deps, {
        workflowIdOrName: name,
      }),
    );
    const last = events.at(-1);
    if (last?.kind === "error") return { error: last.error.message };
    assert(last?.kind === "completed");
    const data = last.data as { validations: Check[] };
    return {
      checks: data.validations.map((v) => ({
        name: v.name,
        passed: v.passed,
        ...(v.error ? { error: v.error } : {}),
      })),
    };
  } catch (error) {
    return { thrown: (error as Error).message };
  } finally {
    repo.catalogStore.close();
  }
}

function nestedChecks(outcome: ValidateOutcome): Check[] {
  assert(outcome.checks, JSON.stringify(outcome));
  return outcome.checks.filter((c) =>
    c.name.startsWith("Step inputs for 'call'") || c.name.startsWith("Tags")
  );
}

interface RunOutcome {
  thrown?: string;
  status?: string;
  stepErrors?: string[];
  runs: number[];
}

// a fresh repository context and service each call, as a new process has
async function runOutcome(
  h: Harness,
  watch: Workflow[],
  start: (
    service: WorkflowExecutionService,
  ) => AsyncIterable<WorkflowExecutionEvent>,
): Promise<RunOutcome> {
  const repo = createRepositoryContext({ repoDir: h.dir });
  const outcome: RunOutcome = { runs: [] };
  try {
    const service = new WorkflowExecutionService(
      repo.workflowRepo,
      repo.workflowRunRepo,
      h.dir,
      undefined,
      undefined,
      repo.catalogStore,
    );
    try {
      for await (const event of start(service)) {
        if (event.kind !== "completed") continue;
        outcome.status = event.run.status;
        const stepErrors = event.run.jobs.flatMap((job) =>
          job.steps.flatMap((step) => step.error ? [step.error] : [])
        );
        if (stepErrors.length > 0) outcome.stepErrors = stepErrors;
      }
    } catch (error) {
      outcome.thrown = (error as Error).message;
    }
    for (const w of watch) {
      outcome.runs.push(
        (await repo.workflowRunRepo.findAllByWorkflowId(w.id)).length,
      );
    }
    return outcome;
  } finally {
    repo.catalogStore.close();
  }
}

function threeLevels(): {
  parent: Workflow;
  child: Workflow;
  grandchild: Workflow;
} {
  const grandchild = workflow("grandchild", [behaviorStep("tagged")]);
  const child = workflow("child", [
    behaviorStep("clean"),
    callStep("grandchild"),
  ]);
  const parent = workflow("parent", [callStep("child")]);
  return { parent, child, grandchild };
}

const NESTED_TAGS_CHECK = "Tags for 'call' in job 'main' (workflow 'child')";
const NESTED_TAGS_ERROR =
  `Step 'call' in job 'main' (workflow 'grandchild'): Step 'run-tagged' in job 'main': ${REFUSAL}`;
const NESTED_RUN_REFUSAL =
  `Step 'call' in job 'main' (workflow 'child'): ${NESTED_TAGS_ERROR}`;

Deno.test("Integration: workflow validate of a parent fails a reserved tag on a definition only a grandchild step names, naming the path", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    await h.define("tagged", { tags: RESERVED });
    const { parent, child, grandchild } = threeLevels();
    await h.save(grandchild, child, parent);

    assertEquals(nestedChecks(await validate(h.dir, "parent")), [
      {
        name: "Step inputs for 'call' in job 'main' (workflow: child)",
        passed: true,
      },
      { name: NESTED_TAGS_CHECK, passed: false, error: NESTED_TAGS_ERROR },
    ]);
  });
});

Deno.test("Integration: workflow run of a parent is refused before any step runs when a grandchild step names a definition with a reserved tag", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    await h.define("tagged", { tags: RESERVED });
    const { parent, child, grandchild } = threeLevels();
    await h.save(grandchild, child, parent);

    const outcome = await runOutcome(
      h,
      [parent, child, grandchild],
      (s) => s.run("parent"),
    );

    assertEquals(outcome, { thrown: NESTED_RUN_REFUSAL, runs: [0, 0, 0] });
    assertEquals(h.executions, []);
  });
});

Deno.test("Integration: a nested step naming a behavior two definitions share resolves to the one first in walk order, in validate and run", async () => {
  for (const taggedFirst of [true, false]) {
    await withHarness(async (h) => {
      await h.define("shared", {
        type: h.first,
        tags: taggedFirst ? RESERVED : {},
      });
      await h.define("shared", {
        type: h.last,
        tags: taggedFirst ? {} : RESERVED,
      });
      const child = workflow("child", [behaviorStep("shared")]);
      const parent = workflow("parent", [callStep("child")]);
      await h.save(child, parent);

      const tags = nestedChecks(await validate(h.dir, "parent")).find((c) =>
        c.name.startsWith("Tags")
      );
      const run = await runOutcome(h, [parent, child], (s) => s.run("parent"));

      if (taggedFirst) {
        assertEquals(tags?.name, NESTED_TAGS_CHECK);
        assertEquals(tags?.passed, false);
        assertStringIncludes(tags?.error ?? "", "definition 'shared'");
        assertStringIncludes(run.thrown ?? "", "definition 'shared'");
        assertEquals(run.runs, [0, 0]);
        assertEquals(h.executions, []);
      } else {
        assertEquals(tags, { name: "Tags", passed: true });
        assertEquals(run, { status: "succeeded", runs: [1, 1] });
        assertEquals(h.executions, ["shared@a"]);
      }
    });
  }
});

Deno.test("Integration: a child workflow named by id is followed by workflow validate and workflow run", async () => {
  await withHarness(async (h) => {
    await h.define("tagged", { tags: RESERVED });
    const child = workflow("child", [behaviorStep("tagged")]);
    const parent = workflow("parent", [callStep(child.id)]);
    await h.save(child, parent);

    const tags = nestedChecks(await validate(h.dir, "parent")).find((c) =>
      c.name.startsWith("Tags")
    );
    assertEquals(tags, {
      name: NESTED_TAGS_CHECK,
      passed: false,
      error: `Step 'run-tagged' in job 'main': ${REFUSAL}`,
    });
    const run = await runOutcome(h, [parent, child], (s) => s.run("parent"));
    assertEquals(run, {
      thrown:
        `Step 'call' in job 'main' (workflow 'child'): Step 'run-tagged' in job 'main': ${REFUSAL}`,
      runs: [0, 0],
    });
    assertEquals(h.executions, []);
  });
});

Deno.test("Integration: a parent calling a missing child workflow still validates, and its run fails as before", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    const parent = workflow("parent", [
      behaviorStep("clean"),
      callStep("absent"),
    ]);
    await h.save(parent);

    assertEquals(nestedChecks(await validate(h.dir, "parent")), [
      {
        name:
          "Step inputs for 'call' in job 'main' (workflow: absent) (workflow not found, skipped)",
        passed: true,
      },
      { name: "Tags", passed: true },
    ]);
    const run = await runOutcome(h, [parent], (s) => s.run("parent"));
    assertEquals(run, {
      status: "failed",
      stepErrors: ["Workflow not found: absent"],
      runs: [1],
    });
  });
});

Deno.test("Integration: workflow validate of a parent in a cycle of nested workflows ends and reports what the cycle reaches", async () => {
  await withHarness(async (h) => {
    await h.define("tagged", { tags: RESERVED });
    const parent = workflow("parent", [callStep("child")]);
    const child = workflow("child", [
      behaviorStep("tagged"),
      callStep("parent"),
    ]);
    await h.save(parent, child);

    const tags = nestedChecks(await validate(h.dir, "parent")).find((c) =>
      c.name.startsWith("Tags")
    );
    assertEquals(tags, {
      name: NESTED_TAGS_CHECK,
      passed: false,
      error: `Step 'run-tagged' in job 'main': ${REFUSAL}`,
    });
  });
});

Deno.test("Integration: a child workflow named by an expression is not followed before the run, and is refused only when its step runs", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    await h.define("tagged", { tags: RESERVED });
    const child = workflow("child", [behaviorStep("tagged")]);
    const parent = workflow(
      "parent",
      [
        behaviorStep("clean"),
        Step.create({
          name: "call",
          task: StepTask.workflow("${{ inputs.wf }}"),
          dependsOn: [{
            step: "run-clean",
            condition: TriggerCondition.succeeded(),
          }],
        }),
      ],
      {
        type: "object",
        properties: { wf: { type: "string", default: "child" } },
      },
    );
    await h.save(child, parent);

    const tags = nestedChecks(await validate(h.dir, "parent")).find((c) =>
      c.name.startsWith("Tags")
    );
    assertEquals(tags, { name: "Tags", passed: true });
    const run = await runOutcome(
      h,
      [parent, child],
      (s) => s.run("parent", { inputs: { wf: "child" } }),
    );
    assertEquals(run, {
      status: "failed",
      stepErrors: [`Step 'run-tagged' in job 'main': ${REFUSAL}`],
      runs: [1, 0],
    });
    assertEquals(h.executions, ["clean@a"]);
  });
});

Deno.test("Integration: workflow validate of a parent whose child workflow file fails to parse still reports", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    const parent = workflow("parent", [
      behaviorStep("clean"),
      callStep("broken"),
    ]);
    await h.save(parent);
    await Deno.writeTextFile(
      join(h.dir, "workflows", "broken.yaml"),
      `id: ${crypto.randomUUID()}\nname: broken\njobs: 7\n`,
    );

    assertEquals(nestedChecks(await validate(h.dir, "parent")), [
      {
        name:
          "Step inputs for 'call' in job 'main' (workflow: broken) (workflow not found, skipped)",
        passed: true,
      },
      { name: "Tags", passed: true },
    ]);
  });
});

Deno.test({
  name:
    "Integration: a child step naming a missing behavior beside an unreadable definition file: validate still reports, and the run fails as before",
  ignore: CANNOT_LOCK,
  fn: async () => {
    await withHarness(async (h) => {
      await h.define("clean");
      const child = workflow("child", [
        behaviorStep("clean"),
        behaviorStep("missing"),
      ]);
      const parent = workflow("parent", [callStep("child")]);
      await h.save(child, parent);
      const locked = await lockedDefinition(h.dir);
      try {
        assertEquals(nestedChecks(await validate(h.dir, "parent")), [
          {
            name: "Step inputs for 'call' in job 'main' (workflow: child)",
            passed: true,
          },
          { name: "Tags", passed: true },
        ]);
        const run = await runOutcome(
          h,
          [parent, child],
          (s) => s.run("parent"),
        );
        const { stepErrors, ...rest } = run;
        assertEquals(rest, { status: "failed", runs: [1, 0] });
        assertEquals(stepErrors?.length, 1);
        assertStringIncludes(
          stepErrors?.[0] ?? "",
          `Failed to read definition file ${locked}`,
        );
        assertEquals(h.executions, []);
      } finally {
        await Deno.chmod(locked, 0o644);
      }
    });
  },
});

Deno.test({
  name:
    "Integration: a top-level step naming a missing behavior beside an unreadable definition file fails workflow validate with the read error",
  ignore: CANNOT_LOCK,
  fn: async () => {
    await withHarness(async (h) => {
      await h.define("clean");
      const parent = workflow("parent", [behaviorStep("missing")]);
      await h.save(parent);
      const locked = await lockedDefinition(h.dir);
      try {
        const outcome = await validate(h.dir, "parent");
        assertEquals(Object.keys(outcome), ["thrown"]);
        assertStringIncludes(
          outcome.thrown ?? "",
          `Failed to read definition file ${locked}`,
        );
      } finally {
        await Deno.chmod(locked, 0o644);
      }
    });
  },
});

Deno.test("Integration: resume of a failed parent is refused before any step runs when a grandchild step names a definition with a reserved tag", async () => {
  await withHarness(async (h) => {
    await h.define("clean");
    await h.define("tagged", { tags: RESERVED });
    const { parent, child, grandchild } = threeLevels();
    // the children are saved only after the first run, so that run fails
    await h.save(parent);
    const failed = await runOutcome(
      h,
      [parent, child, grandchild],
      (s) => s.run("parent"),
    );
    assertEquals(failed, {
      status: "failed",
      stepErrors: ["Workflow not found: child"],
      runs: [1, 0, 0],
    });
    await h.save(grandchild, child);
    const repo = createRepositoryContext({ repoDir: h.dir });
    let runId: string;
    try {
      const [run] = await repo.workflowRunRepo.findAllByWorkflowId(parent.id);
      runId = run.id;
    } finally {
      repo.catalogStore.close();
    }

    const resumed = await runOutcome(
      h,
      [parent, child, grandchild],
      (s) => s.resume("parent", runId, { fromStep: "call" }),
    );

    assertEquals(resumed, { thrown: NESTED_RUN_REFUSAL, runs: [1, 0, 0] });
    assertEquals(h.executions, []);
  });
});
