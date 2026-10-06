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
 * Expression text is authorized against the principal who supplies it, when
 * they supply it (swamp-club#2755, swamp-club#2786, swamp-club#2672): a
 * writer adding expressions or workflow steps, and a caller passing
 * expressions in run inputs. Runs and evaluations of stored content are not
 * re-checked, and evaluate and validate never resolve env.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  Definition,
  type DefinitionData,
} from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { MAX_EXPRESSION_TARGETS } from "../src/serve/handlers/expression_reference_authorization.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveData,
  saveModel,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

/** Allow everything, but deny reading prod-* data. */
const GRANTS: Grant[] = [
  grant({ resource: { kind: "model", pattern: "*" } }),
  grant({ resource: { kind: "workflow", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
  grant({
    effect: "deny",
    actions: ["read"],
    resource: { kind: "data", pattern: "prod-*" },
  }),
];

/** The same, denying data by tag rather than name. */
const TAG_GRANTS: Grant[] = [
  ...GRANTS.slice(0, 3),
  grant({
    effect: "deny",
    actions: ["read"],
    resource: { kind: "data", pattern: "*" },
    condition: 'tags.env == "prod"',
  }),
];

interface Fixtures {
  repo: ServeRepo;
  ctx: ConnectionContext;
  prod: Definition;
  dev: Definition;
}

async function withFixtures(
  fn: (f: Fixtures) => Promise<void>,
  grants: Grant[] = GRANTS,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const prod = await saveModel(repo, "prod-db", { env: "prod" });
    const dev = await saveModel(repo, "dev-db");
    await saveData(repo, prod, "state");
    await saveData(repo, dev, "state");
    await fn({ repo, ctx: createServeCtx(repo, grants), prod, dev });
  });
}

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** Saves `name` with `globalArguments`, as an admin would on disk. */
async function saveWithArgs(
  repo: ServeRepo,
  name: string,
  globalArguments: Record<string, unknown>,
): Promise<Definition> {
  const definition = Definition.create({ name, globalArguments, tags: {} });
  await repo.repoContext.definitionRepo.save(repo.modelType, definition);
  return definition;
}

/** A model.edit request replacing `definition`'s content. */
function editRequest(definition: Definition, changes: Partial<DefinitionData>) {
  return request("model.edit", {
    modelIdOrName: definition.id,
    content: stringifyYaml({
      ...JSON.parse(JSON.stringify(definition.toData())),
      ...changes,
    }),
  });
}

function assertRefused(frames: Frame[], label: string): void {
  const error = errorFrame(frames);
  assert(error, `${label}: expected a refusal`);
  assertEquals(error.error?.code, "unauthorized", label);
}

function assertAllowed(frames: Frame[], label: string): void {
  assertEquals(errorFrame(frames), undefined, label);
}

async function storedArgs(
  repo: ServeRepo,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const found = await repo.repoContext.definitionRepo.findByNameGlobal(name);
  return found?.definition.globalArguments;
}

const REFUSED_REFERENCES = [
  '${{ data.latest("prod-db", "state").attributes.value }}',
  '${{ data.version("prod-db", "state", 1) }}',
  '${{ model["prod-db"].resource }}',
  "${{ model.prod-db.resource.state }}",
  '${{ file.contents("prod-db", "state") }}',
  '${{ data.latest("prod-" + "db", "state") }}',
  '${{ data.query("modelName == \\"dev-db\\"") }}',
  '${{ data.findByTag("type", "resource") }}',
];

Deno.test("serve expressions: model.create refuses a reference to unreadable data and saves nothing", async () => {
  await withFixtures(async (f) => {
    for (const [i, expr] of REFUSED_REFERENCES.entries()) {
      const name = `leak-${i}`;
      const frames = await sendRequest(
        f.ctx,
        request("model.create", {
          typeArg: f.repo.modelType.normalized,
          name,
          globalArguments: { leak: expr },
        }),
      );
      assertRefused(frames, expr);
      assertEquals(await storedArgs(f.repo, name), undefined, expr);
    }
  });
});

Deno.test("serve expressions: model.create allows readable references and env", async () => {
  await withFixtures(async (f) => {
    const frames = await sendRequest(
      f.ctx,
      request("model.create", {
        typeArg: f.repo.modelType.normalized,
        name: "reader",
        globalArguments: {
          ok: '${{ data.latest("dev-db", "state").attributes.value }}',
          region: "${{ env.AWS_REGION }}",
        },
      }),
    );
    assertAllowed(frames, "readable reference");
  });
});

Deno.test("serve expressions: admins and auth mode none are not checked", async () => {
  await withFixtures(async (f) => {
    const frames = await sendRequest(
      createServeCtx(f.repo),
      request("model.create", {
        typeArg: f.repo.modelType.normalized,
        name: "unchecked",
        globalArguments: { leak: REFUSED_REFERENCES[0] },
      }),
    );
    assertAllowed(frames, "auth mode none");
  });
});

Deno.test("serve expressions: model.edit refuses an added reference and leaves the file", async () => {
  await withFixtures(async (f) => {
    const target = await saveWithArgs(f.repo, "dev-x", { a: "plain" });
    const frames = await sendRequest(
      f.ctx,
      editRequest(target, {
        globalArguments: { a: "plain", leak: REFUSED_REFERENCES[0] },
      }),
    );
    assertRefused(frames, "added reference");
    assertEquals(await storedArgs(f.repo, "dev-x"), { a: "plain" });
  });
});

Deno.test("serve expressions: model.edit keeps working on a model that already reads other data", async () => {
  await withFixtures(async (f) => {
    // An admin wired prod-db's data into this model; editing an unrelated
    // field must not re-check it.
    const target = await saveWithArgs(f.repo, "dev-x", {
      fromProd: REFUSED_REFERENCES[0],
      note: "v1",
    });
    const frames = await sendRequest(
      f.ctx,
      editRequest(target, {
        globalArguments: { fromProd: REFUSED_REFERENCES[0], note: "v2" },
      }),
    );
    assertAllowed(frames, "unrelated edit");
  });
});

Deno.test("serve expressions: rewriting a stored data.query predicate is checked", async () => {
  await withFixtures(async (f) => {
    const target = await saveWithArgs(f.repo, "dev-x", {
      q: '${{ data.query("modelName == \\"dev-db\\"") }}',
    });
    const frames = await sendRequest(
      f.ctx,
      editRequest(target, {
        globalArguments: {
          q: '${{ data.query("modelName == \\"prod-db\\"") }}',
        },
      }),
    );
    assertRefused(frames, "rewritten predicate");
  });
});

Deno.test("serve expressions: retargeting a computed reference through a plain value is refused", async () => {
  await withFixtures(async (f) => {
    const leak =
      '${{ data.latest(self.globalArguments.target, "state").attributes.value }}';
    const target = await saveWithArgs(f.repo, "dev-x", {
      target: "dev-db",
      leak,
    });
    const frames = await sendRequest(
      f.ctx,
      editRequest(target, { globalArguments: { target: "prod-db", leak } }),
    );
    assertRefused(frames, "retarget");
    assertEquals((await storedArgs(f.repo, "dev-x"))?.target, "dev-db");
  });
});

Deno.test("serve expressions: a reference is judged on the current owner of the data it returns", async () => {
  await withFixtures(async (f) => {
    // prod-db is renamed; its data stays stored under the old name, and its
    // tags (env: prod) move with it.
    const renamed = Definition.fromData({
      ...f.prod.toData(),
      name: "legacy",
    });
    await f.repo.repoContext.definitionRepo.save(f.repo.modelType, renamed);
    const frames = await sendRequest(
      f.ctx,
      request("model.create", {
        typeArg: f.repo.modelType.normalized,
        name: "via-old-name",
        globalArguments: { leak: REFUSED_REFERENCES[0] },
      }),
    );
    assertRefused(frames, "old name of a tag-denied model");
  }, TAG_GRANTS);
});

Deno.test("serve expressions: a reference by definition id is judged on that definition", async () => {
  await withFixtures(async (f) => {
    const frames = await sendRequest(
      f.ctx,
      request("model.create", {
        typeArg: f.repo.modelType.normalized,
        name: "via-id",
        globalArguments: { leak: `\${{ model["${f.prod.id}"].resource }}` },
      }),
    );
    assertRefused(frames, "reference by id");
  });
});

Deno.test("serve expressions: workflow.edit refuses an added reference", async () => {
  await withFixtures(async (f) => {
    const workflow = await saveWorkflow(f.repo, "dev-flow", f.dev);
    const data = JSON.parse(JSON.stringify(workflow.toData()));
    const withLeak = structuredClone(data);
    withLeak.jobs[0].steps[0].task.inputs = { x: REFUSED_REFERENCES[0] };
    assertRefused(
      await sendRequest(
        f.ctx,
        request("workflow.edit", {
          workflowIdOrName: workflow.id,
          content: stringifyYaml(withLeak),
        }),
      ),
      "workflow reference",
    );
  });
});

Deno.test("serve expressions: workflow.edit refuses a step running a model the writer may not run", async () => {
  await withServeRepo(async (repo) => {
    const prod = await saveModel(repo, "prod-db");
    const dev = await saveModel(repo, "dev-db");
    const ctx = createServeCtx(repo, [
      grant({ resource: { kind: "model", pattern: "*" } }),
      grant({ resource: { kind: "workflow", pattern: "*" } }),
      grant({
        effect: "deny",
        actions: ["run"],
        resource: { kind: "model", pattern: "prod-*" },
      }),
    ]);
    const workflow = await saveWorkflow(repo, "dev-flow", dev);
    const added = JSON.parse(JSON.stringify(workflow.toData()));
    added.jobs[0].steps.push({
      name: "sneak",
      task: {
        type: "model_method",
        modelIdOrName: prod.name,
        methodName: "noop",
      },
    });
    assertRefused(
      await sendRequest(
        ctx,
        request("workflow.edit", {
          workflowIdOrName: workflow.id,
          content: stringifyYaml(added),
        }),
      ),
      "added prod step",
    );

    // A step an admin already stored is not re-checked on an unrelated edit.
    const adminFlow = Workflow.create({
      name: "admin-flow",
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "prod",
              task: StepTask.modelMethod(prod.name, "noop"),
            }),
          ],
        }),
      ],
    });
    await repo.repoContext.workflowRepo.save(adminFlow);
    const retagged = {
      ...JSON.parse(JSON.stringify(adminFlow.toData())),
      tags: { edited: "true" },
    };
    assertAllowed(
      await sendRequest(
        ctx,
        request("workflow.edit", {
          workflowIdOrName: adminFlow.id,
          content: stringifyYaml(retagged),
        }),
      ),
      "unrelated edit of an admin workflow",
    );
  });
});

/**
 * Registers a type whose `echo` method takes a `note` and records the value
 * it was given, for input tests.
 */
async function withEchoType(
  fn: (type: ModelType, notes: unknown[]) => Promise<void>,
): Promise<void> {
  const notes: unknown[] = [];
  const type = ModelType.create(`test/echo-${crypto.randomUUID().slice(0, 8)}`);
  modelRegistry.register({
    type,
    version: "2026.01.01.1",
    methods: {
      echo: {
        description: "takes a note",
        kind: "read",
        arguments: z.object({ note: z.string().optional() }),
        execute: (args: { note?: string }) => {
          notes.push(args.note);
          return Promise.resolve({});
        },
      },
    },
  });
  try {
    await fn(type, notes);
  } finally {
    modelRegistry.invalidateType(type);
  }
}

Deno.test("serve expressions: run inputs are authorized against the caller", async () => {
  await withEchoType(async (echoType) => {
    await withFixtures(async (f) => {
      const echo = Definition.create({ name: "echo-x", globalArguments: {} });
      await f.repo.repoContext.definitionRepo.save(echoType, echo);
      const runOnly = createServeCtx(f.repo, [
        grant({
          actions: ["read", "run"],
          resource: { kind: "model", pattern: "*" },
        }),
        ...GRANTS.slice(2),
      ]);
      const run = (ctx: ConnectionContext, note: string) =>
        sendRequest(
          ctx,
          request("model.method.run", {
            modelIdOrName: "echo-x",
            methodName: "echo",
            inputs: { note },
          }),
        );

      const envFrames = await run(runOnly, "${{ env.AWS_SECRET_ACCESS_KEY }}");
      assertRefused(envFrames, "env from a run-only caller");
      assertStringIncludes(
        errorFrame(envFrames)!.error!.message,
        "reference it in the model definition",
      );
      assertRefused(
        await run(
          runOnly,
          '${{ env.HOME + data.latest("prod-db", "state").attributes.value }}',
        ),
        "env and data",
      );
      assertRefused(
        await run(f.ctx, REFUSED_REFERENCES[0]),
        "unreadable data, even with write",
      );
      assertAllowed(await run(runOnly, "plain value"), "plain input");
      assertAllowed(
        await run(f.ctx, "${{ env.HOME }}"),
        "env with write on the model",
      );
    });
  });
});

Deno.test("serve expressions: evaluate and validate never resolve env", async () => {
  await withMockedEnv({ SWAMP_EXPR_SENTINEL: "sentinel-2786" }, async () => {
    await withFixtures(async (f) => {
      await saveWithArgs(f.repo, "env-model", {
        secret: "${{ env.SWAMP_EXPR_SENTINEL }}",
      });
      const flow = Workflow.create({
        name: "env-flow",
        jobs: [
          Job.create({
            name: "main",
            steps: [
              Step.create({
                name: "s",
                task: StepTask.modelMethod("dev-db", "noop", {
                  x: "${{ env.SWAMP_EXPR_SENTINEL }}",
                }),
              }),
            ],
          }),
        ],
      });
      await f.repo.repoContext.workflowRepo.save(flow);
      for (
        const [type, payload] of [
          ["model.evaluate", { modelIdOrName: "env-model" }],
          ["model.validate", { modelIdOrName: "env-model" }],
          ["workflow.evaluate", { workflowIdOrName: "env-flow" }],
          ["workflow.validate", { workflowIdOrName: "env-flow" }],
        ] as const
      ) {
        const frames = await sendRequest(f.ctx, request(type, payload));
        assertEquals(
          JSON.stringify(frames).includes("sentinel-2786"),
          false,
          `${type} resolved env`,
        );
      }
    });
  });
});

Deno.test("serve expressions: past the target cap a request is judged as reading any data", async () => {
  await withFixtures(async (f) => {
    // Each name is readable on its own; there are more than the check will
    // look up one by one, so any data deny refuses the request.
    const globalArguments = Object.fromEntries(
      Array.from({ length: MAX_EXPRESSION_TARGETS + 1 }, (_, i) => [
        `a${i}`,
        `\${{ data.latest("dev-${i}", "state") }}`,
      ]),
    );
    assertRefused(
      await sendRequest(
        f.ctx,
        request("model.create", {
          typeArg: f.repo.modelType.normalized,
          name: "many",
          globalArguments,
        }),
      ),
      "too many targets",
    );
  });
});

Deno.test("serve expressions: workflow.run inputs are values, never evaluated as expressions", async () => {
  await withMockedEnv({ SWAMP_EXPR_SENTINEL: "sentinel-2786" }, async () => {
    await withEchoType(async (echoType, notes) => {
      await withFixtures(async (f) => {
        const echo = Definition.create({ name: "echo-x", globalArguments: {} });
        await f.repo.repoContext.definitionRepo.save(echoType, echo);
        const flow = Workflow.create({
          name: "echo-flow",
          inputs: { type: "object", properties: { x: { type: "string" } } },
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "echo",
                  task: StepTask.modelMethod("echo-x", "echo", {
                    note: "${{ inputs.x }}",
                  }),
                }),
              ],
            }),
          ],
        });
        await f.repo.repoContext.workflowRepo.save(flow);
        const supplied = "${{ env.SWAMP_EXPR_SENTINEL }}";
        await sendRequest(
          f.ctx,
          request("workflow.run", {
            workflowIdOrName: "echo-flow",
            inputs: { x: supplied },
          }),
        );
        // The step ran and got the text it was given, unevaluated.
        assertEquals(notes, [supplied]);
      });
    });
  });
});

/** Grants for workflow-step tests: run denied on prod-* and locked-*. */
const STEP_GRANTS: Grant[] = [
  grant({ resource: { kind: "model", pattern: "*" } }),
  grant({ resource: { kind: "workflow", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
  grant({
    effect: "deny",
    actions: ["read"],
    resource: { kind: "data", pattern: "prod-*" },
  }),
  ...["prod-*", "locked-*"].map((pattern) =>
    grant({
      effect: "deny",
      actions: ["run"],
      resource: { kind: "model", pattern },
    })
  ),
  grant({
    effect: "deny",
    actions: ["run"],
    resource: { kind: "workflow", pattern: "prod-*" },
  }),
];

type WorkflowJson = {
  inputs?: unknown;
  tags?: Record<string, string>;
  jobs: { name: string; steps: Record<string, unknown>[] }[];
};

function workflowJson(workflow: Workflow): WorkflowJson {
  return JSON.parse(JSON.stringify(workflow.toData()));
}

function editWorkflow(
  ctx: ConnectionContext,
  workflow: Workflow,
  change: (data: WorkflowJson) => void,
): Promise<Frame[]> {
  const data = workflowJson(workflow);
  change(data);
  return sendRequest(
    ctx,
    request("workflow.edit", {
      workflowIdOrName: workflow.id,
      content: stringifyYaml(data),
    }),
  );
}

function addStep(task: Record<string, unknown>) {
  return (data: WorkflowJson) => {
    data.jobs[0].steps.push({
      name: `added-${data.jobs[0].steps.length}`,
      task,
    });
  };
}

async function withStepFixtures(
  fn: (f: Fixtures & { flow: Workflow }) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const prod = await saveModel(repo, "prod-db", { env: "prod" });
    const dev = await saveModel(repo, "dev-db");
    await saveModel(repo, "locked-db");
    await saveData(repo, prod, "state");
    await saveData(repo, dev, "state");
    await saveWorkflow(repo, "prod-flow", dev);
    await saveWorkflow(repo, "dev-flow", dev);
    const flow = await saveWorkflow(repo, "editable", dev);
    await fn({ repo, ctx: createServeCtx(repo, STEP_GRANTS), prod, dev, flow });
  });
}

Deno.test("serve expressions: workflow.edit checks each kind of step it adds", async () => {
  await withStepFixtures(async (f) => {
    const type = f.repo.modelType.normalized;
    const cases: [string, Record<string, unknown>][] = [
      ["nested workflow", { type: "workflow", workflowIdOrName: "prod-flow" }],
      ["direct step on a denied name", {
        type: "model_method",
        modelType: type,
        modelName: "prod-new",
        methodName: "noop",
      }],
      ["computed model", {
        type: "model_method",
        modelIdOrName: "${{ inputs.m }}",
        methodName: "noop",
      }],
    ];
    for (const [label, task] of cases) {
      assertRefused(await editWorkflow(f.ctx, f.flow, addStep(task)), label);
    }
    // Even with no model denies at all, a computed target can name a
    // restricted or control-plane model, so a non-admin may not add one.
    const noDenies = createServeCtx(f.repo, [
      grant({ resource: { kind: "model", pattern: "*" } }),
      grant({ resource: { kind: "workflow", pattern: "*" } }),
    ]);
    assertRefused(
      await editWorkflow(noDenies, f.flow, addStep(cases[2][1])),
      "computed model with no model denies",
    );
    // An admin may add a computed target.
    assertAllowed(
      await editWorkflow(
        createServeCtx(f.repo),
        f.flow,
        addStep(cases[2][1]),
      ),
      "computed model, auth none",
    );
    assertAllowed(
      await editWorkflow(
        f.ctx,
        f.flow,
        addStep({ type: "workflow", workflowIdOrName: "dev-flow" }),
      ),
      "readable nested workflow",
    );
  });
});

Deno.test("serve expressions: a direct step needs run on its type, and admin for a restricted type", async () => {
  await withStepFixtures(async (f) => {
    const type = f.repo.modelType.normalized;
    const typeDenied = createServeCtx(f.repo, [
      ...STEP_GRANTS,
      grant({
        effect: "deny",
        actions: ["run"],
        resource: { kind: "model", pattern: type },
      }),
    ]);
    assertRefused(
      await editWorkflow(
        typeDenied,
        f.flow,
        addStep({
          type: "model_method",
          modelType: type,
          modelName: "fresh",
          methodName: "noop",
        }),
      ),
      "denied type",
    );
    await saveModel(f.repo, "other-db");
    const restricted = createServeCtx(f.repo, STEP_GRANTS);
    restricted.authConfig.restrictedModelTypes = [type];
    assertRefused(
      await editWorkflow(
        restricted,
        f.flow,
        addStep({
          type: "model_method",
          modelIdOrName: "other-db",
          methodName: "noop",
        }),
      ),
      "restricted type without admin",
    );
  });
});

Deno.test("serve expressions: workflow.edit checks assert predicates and the methods they run", async () => {
  await withStepFixtures(async (f) => {
    const assertStep = (expr: string) =>
      addStep({ type: "assert", expr, message: "m" });
    assertRefused(
      await editWorkflow(
        f.ctx,
        f.flow,
        assertStep('data.latest("prod-db", "state") != null'),
      ),
      "assert reading unreadable data",
    );
    // locked-db's data is readable, but running it is denied.
    assertRefused(
      await editWorkflow(
        f.ctx,
        f.flow,
        assertStep('model.method("locked-db", "noop") != null'),
      ),
      "assert running a model the writer may not run",
    );
    assertRefused(
      await editWorkflow(
        f.ctx,
        f.flow,
        assertStep('model.method(inputs.m, "noop") != null'),
      ),
      "assert running a computed model",
    );
    assertAllowed(
      await editWorkflow(
        f.ctx,
        f.flow,
        assertStep('model.method("dev-db", "noop") != null'),
      ),
      "assert running a runnable model",
    );
  });
});

Deno.test("serve expressions: an input default can't retarget a stored computed step or expression, a retag is fine", async () => {
  await withStepFixtures(async (f) => {
    const flow = Workflow.fromData(
      {
        id: crypto.randomUUID(),
        name: "computed-flow",
        version: 1,
        inputs: {
          type: "object",
          properties: { m: { type: "string", default: "dev-db" } },
        },
        jobs: [{
          name: "main",
          steps: [{
            name: "s",
            task: {
              type: "model_method",
              modelIdOrName: "${{ inputs.m }}",
              methodName: "noop",
              inputs: { x: '${{ data.latest(inputs.m, "state") }}' },
            },
          }],
        }],
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
    await f.repo.repoContext.workflowRepo.save(flow);
    assertRefused(
      await editWorkflow(f.ctx, flow, (data) => {
        data.inputs = {
          type: "object",
          properties: { m: { type: "string", default: "prod-db" } },
        };
      }),
      "retarget through the input default",
    );
    assertAllowed(
      await editWorkflow(f.ctx, flow, (data) => {
        data.tags = { team: "a" };
      }),
      "retag of an admin workflow with computed targets",
    );
  });
});

Deno.test("serve expressions: every definition sharing a name is judged", async () => {
  await withEchoType(async (echoType) => {
    await withServeRepo(async (repo) => {
      await saveModel(repo, "twin");
      const prodTwin = Definition.create({
        name: "twin",
        globalArguments: {},
        tags: { env: "prod" },
      });
      await repo.repoContext.definitionRepo.save(echoType, prodTwin);
      const ctx = createServeCtx(repo, TAG_GRANTS);
      assertRefused(
        await sendRequest(
          ctx,
          request("model.create", {
            typeArg: repo.modelType.normalized,
            name: "reader",
            globalArguments: { x: '${{ data.latest("twin", "state") }}' },
          }),
        ),
        "a name one tag-denied definition shares",
      );
    });
  });
});

Deno.test("serve expressions: changing a global argument's expression retargets what self reads", async () => {
  await withFixtures(async (f) => {
    const leak = '${{ data.latest(self.globalArguments.target, "state") }}';
    await saveWithArgs(f.repo, "dev-x", { target: '${{ "dev-db" }}', leak });
    // Edit the stored copy, so the expression is the only thing that changes.
    const target = (await f.repo.repoContext.definitionRepo.findByNameGlobal(
      "dev-x",
    ))!.definition;
    assertRefused(
      await sendRequest(
        f.ctx,
        editRequest(target, {
          globalArguments: { target: '${{ "prod-db" }}', leak },
        }),
      ),
      "expression swap in a self-read field",
    );
  });
});

Deno.test("serve expressions: a self-reading expression copied to another step is checked there", async () => {
  await withStepFixtures(async (f) => {
    const leak = '${{ data.latest(self.e, "state") }}';
    const flow = Workflow.fromData(
      {
        id: crypto.randomUUID(),
        name: "loops",
        version: 1,
        jobs: [{
          name: "main",
          steps: [
            {
              name: "a",
              forEach: { item: "e", in: '${{ ["dev-db"] }}' },
              task: {
                type: "model_method",
                modelIdOrName: "dev-db",
                methodName: "noop",
                inputs: { x: leak },
              },
            },
            {
              name: "b",
              forEach: { item: "e", in: '${{ ["prod-db"] }}' },
              task: {
                type: "model_method",
                modelIdOrName: "dev-db",
                methodName: "noop",
              },
            },
          ],
        }],
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
    await f.repo.repoContext.workflowRepo.save(flow);
    assertRefused(
      await editWorkflow(f.ctx, flow, (data) => {
        data.jobs[0].steps[1].task = {
          ...(data.jobs[0].steps[1].task as Record<string, unknown>),
          inputs: { x: leak },
        };
      }),
      "copied into a step iterating prod-db",
    );
  });
});

Deno.test("serve expressions: a self-computed step target placed in another step is checked there", async () => {
  await withStepFixtures(async (f) => {
    for (
      const task of [
        {
          type: "model_method",
          modelIdOrName: "${{ self.e }}",
          methodName: "noop",
        },
        { type: "workflow", workflowIdOrName: "${{ self.e }}" },
      ]
    ) {
      // An admin's workflow: step a runs a computed target over dev items,
      // step b iterates prod items with a literal task.
      const flow = Workflow.fromData(
        {
          id: crypto.randomUUID(),
          name: `loops-${task.type}`,
          version: 1,
          jobs: [{
            name: "main",
            steps: [
              {
                name: "a",
                forEach: { item: "e", in: '${{ ["dev-db"] }}' },
                task,
              },
              {
                name: "b",
                forEach: { item: "e", in: '${{ ["prod-db"] }}' },
                task: {
                  type: "model_method",
                  modelIdOrName: "dev-db",
                  methodName: "noop",
                },
              },
            ],
          }],
        } as unknown as Parameters<typeof Workflow.fromData>[0],
      );
      await f.repo.repoContext.workflowRepo.save(flow);
      assertRefused(
        await editWorkflow(f.ctx, flow, (data) => {
          data.jobs[0].steps[1].task = { ...task };
        }),
        `${task.type} target copied into the prod step`,
      );
    }
  });
});

Deno.test("serve expressions: a stored literal reference sent somewhere new is checked", async () => {
  await withStepFixtures(async (f) => {
    await saveModel(f.repo, "echo-db");
    const creds = '${{ data.latest("prod-db", "state").attributes.value }}';
    const flow = Workflow.fromData(
      {
        id: crypto.randomUUID(),
        name: "migrate",
        version: 1,
        jobs: [{
          name: "main",
          steps: [{
            name: "m",
            task: {
              type: "model_method",
              modelIdOrName: "dev-db",
              methodName: "noop",
              inputs: { password: creds },
            },
          }],
        }],
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
    await f.repo.repoContext.workflowRepo.save(flow);
    assertRefused(
      await editWorkflow(f.ctx, flow, (data) => {
        (data.jobs[0].steps[0].task as Record<string, unknown>).modelIdOrName =
          "echo-db";
      }),
      "the step holding it now runs another model",
    );
    assertRefused(
      await editWorkflow(
        f.ctx,
        flow,
        addStep({
          type: "model_method",
          modelIdOrName: "echo-db",
          methodName: "noop",
          inputs: { leak: creds },
        }),
      ),
      "copied into a new step",
    );
    assertAllowed(
      await editWorkflow(f.ctx, flow, (data) => {
        data.tags = { team: "a" };
      }),
      "an unrelated edit leaves it alone",
    );

    // A model edit that moves it to another field is checked too.
    await saveWithArgs(f.repo, "holder", { dbPassword: creds });
    const holder = (await f.repo.repoContext.definitionRepo.findByNameGlobal(
      "holder",
    ))!.definition;
    assertRefused(
      await sendRequest(
        f.ctx,
        editRequest(holder, {
          globalArguments: { dbPassword: creds, shown: creds },
        }),
      ),
      "moved to another model field",
    );
  });
});

Deno.test("serve expressions: a name nothing owns yet needs read on all data", async () => {
  await withFixtures(async (f) => {
    const create = (name: string, ref: string) =>
      sendRequest(
        f.ctx,
        request("model.create", {
          typeArg: f.repo.modelType.normalized,
          name,
          globalArguments: { x: `\${{ data.latest("${ref}", "state") }}` },
        }),
      );
    assertRefused(await create("waits", "not-yet-created"), "unowned name");
    assertAllowed(
      await sendRequest(
        createServeCtx(f.repo, GRANTS.slice(0, 3)),
        request("model.create", {
          typeArg: f.repo.modelType.normalized,
          name: "waits",
          globalArguments: {
            x: '${{ data.latest("not-yet-created", "state") }}',
          },
        }),
      ),
      "unowned name with no data deny",
    );
  });
});

Deno.test("serve expressions: deleting an unrelated step leaves the others' stored references alone", async () => {
  await withStepFixtures(async (f) => {
    const flow = Workflow.fromData(
      {
        id: crypto.randomUUID(),
        name: "ordered",
        version: 1,
        jobs: [{
          name: "main",
          steps: [
            {
              name: "first",
              task: {
                type: "model_method",
                modelIdOrName: "dev-db",
                methodName: "noop",
              },
            },
            {
              name: "admin-step",
              task: {
                type: "model_method",
                modelIdOrName: "dev-db",
                methodName: "noop",
                inputs: {
                  x: '${{ data.latest("prod-db", "state").attributes.value }}',
                },
              },
            },
          ],
        }],
      } as unknown as Parameters<typeof Workflow.fromData>[0],
    );
    await f.repo.repoContext.workflowRepo.save(flow);
    assertAllowed(
      await editWorkflow(f.ctx, flow, (data) => {
        data.jobs[0].steps.shift();
      }),
      "deleting the earlier step",
    );
  });
});
