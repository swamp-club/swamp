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

Deno.test("serve expressions: workflow.edit refuses an added reference and an added step", async () => {
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
