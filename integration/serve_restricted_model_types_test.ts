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
 * `restricted-model-types` restricts a type whatever spelling the list and
 * the request use: model create, method run of a stored definition, direct
 * type execution and adding a workflow step all need admin for an @-scoped
 * extension type listed as `@x/y`, `x/y` or `@X::Y` (swamp-club#3129). So do
 * editing or deleting a model of the type, deleting or renaming its data, and
 * changing a stored workflow step that runs it (swamp-club#3131). Runs
 * through `handleMessage` against a real repository.
 */

import { assert, assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { buildServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
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

const USER_GRANTS = [
  grant({}),
  grant({ resource: { kind: "data", pattern: "*" } }),
  grant({ resource: { kind: "workflow", pattern: "*" } }),
];
const ADMIN_GRANTS = [
  ...USER_GRANTS,
  grant({ actions: ["admin"], resource: { kind: "access", pattern: "*" } }),
];

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** The spellings serve.yaml might list the repo's `@test/serve-…` type as. */
function listedSpellings(repo: ServeRepo): string[] {
  const bare = repo.modelType.normalized.replace(/^@/, "");
  return [`@${bare}`, bare, `@${bare.toUpperCase().replace("/", "::")}`];
}

/** The spellings a client might request the type by. */
function requestedSpellings(repo: ServeRepo): string[] {
  const scoped = repo.modelType.normalized;
  return [scoped, ` ${scoped}`, `@${scoped}`, scoped.toUpperCase()];
}

/** Restricted lists as serve builds them from serve.yaml. */
function restrictedList(entry: string): string[] {
  return buildServeAuthConfig({ restrictedModelTypes: entry })
    .restrictedModelTypes;
}

/** Whether the request was refused for want of admin on access:*. */
function refusedForAdmin(frames: Frame[]): boolean {
  const error = errorFrame(frames);
  if (error?.error?.code === "unauthorized") {
    return error.error.message.includes("access:*");
  }
  const streamed = frames.map((frame) =>
    frame.event as { kind?: string; error?: unknown } | undefined
  ).find((event) => event?.kind === "error")?.error;
  return JSON.stringify(streamed ?? "").includes("access:*");
}

Deno.test("restricted-model-types: model create needs admin for every list and request spelling", async () => {
  await withServeRepo(async (repo) => {
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      for (const typeArg of requestedSpellings(repo)) {
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("model.create", {
            typeArg,
            name: `m-${crypto.randomUUID()}`,
          }),
        );
        assert(
          refusedForAdmin(frames),
          `listed ${listed}, requested ${typeArg}: ${JSON.stringify(frames)}`,
        );
      }
      const admin = await sendRequest(
        createServeCtx(repo, ADMIN_GRANTS, options),
        request("model.create", {
          typeArg: repo.modelType.normalized,
          name: `m-${crypto.randomUUID()}`,
        }),
      );
      assertEquals(errorFrame(admin), undefined, JSON.stringify(admin));
    }
  }, { scopedType: true });
});

Deno.test("restricted-model-types: running a stored definition needs admin for every list spelling", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "probe-model");
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      const frames = await sendRequest(
        createServeCtx(repo, USER_GRANTS, options),
        request("model.method.run", {
          modelIdOrName: model.name,
          methodName: "noop",
        }),
      );
      assert(
        refusedForAdmin(frames),
        `listed ${listed}: ${JSON.stringify(frames)}`,
      );
      const admin = await sendRequest(
        createServeCtx(repo, ADMIN_GRANTS, options),
        request("model.method.run", {
          modelIdOrName: model.name,
          methodName: "noop",
        }),
      );
      assert(!refusedForAdmin(admin), `admin, listed ${listed}`);
    }
  }, { scopedType: true });
});

Deno.test("restricted-model-types: direct type execution needs admin for every list and request spelling", async () => {
  await withServeRepo(async (repo) => {
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      for (const typeArg of requestedSpellings(repo)) {
        const name = `d-${crypto.randomUUID()}`;
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("model.method.run", {
            modelIdOrName: name,
            methodName: "noop",
            typeArg,
            definitionName: name,
          }),
        );
        assert(
          refusedForAdmin(frames),
          `listed ${listed}, requested ${typeArg}: ${JSON.stringify(frames)}`,
        );
      }
    }
  }, { scopedType: true });
});

Deno.test("restricted-model-types: adding a workflow step on the type needs admin for every list and request spelling", async () => {
  // A run is not re-checked step by step: the writer of a step is held to
  // what it runs, when the step is added (design/enablers/access-control.md).
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "step-model");
    const other = await saveModel(repo, "other-model");
    const workflow = await saveWorkflow(repo, "probe-flow", model);
    const base = JSON.parse(JSON.stringify(workflow.toData()));
    const withStep = (task: Record<string, unknown>) => {
      const edited = structuredClone(base);
      edited.jobs[0].steps.push({ name: "added", task });
      return stringifyYaml(edited);
    };
    const tasks = [
      { type: "model_method", modelIdOrName: other.name, methodName: "noop" },
      ...requestedSpellings(repo).map((modelType) => ({
        type: "model_method",
        modelType,
        modelName: `direct-${crypto.randomUUID().slice(0, 8)}`,
        methodName: "noop",
      })),
    ];
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      for (const task of tasks) {
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("workflow.edit", {
            workflowIdOrName: workflow.id,
            content: withStep(task),
          }),
        );
        const error = errorFrame(frames);
        assertEquals(
          error?.error?.code,
          "unauthorized",
          JSON.stringify(frames),
        );
        assert(
          error!.error!.message.includes("a workflow step added here runs"),
          `listed ${listed}, task ${JSON.stringify(task)}: ${
            error!.error!.message
          }`,
        );
      }
    }
  }, { scopedType: true });
});

Deno.test("restricted-model-types: an unlisted type stays open to non-admins", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "open-model");
    const options = { restrictedModelTypes: restrictedList("@other/type") };
    const frames = await sendRequest(
      createServeCtx(repo, USER_GRANTS, options),
      request("model.method.run", {
        modelIdOrName: model.name,
        methodName: "noop",
      }),
    );
    assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  }, { scopedType: true });
});

/** Runs `fn` for an @-scoped extension type and for a bare type. */
async function forEachTypeForm(
  fn: (repo: ServeRepo) => Promise<void>,
): Promise<void> {
  await withServeRepo(fn, { scopedType: true });
  await withServeRepo(fn);
}

/** The edit content that retags `model`. */
function retagged(model: Definition): string {
  return stringifyYaml({
    ...JSON.parse(JSON.stringify(model.toData())),
    tags: { edited: crypto.randomUUID() },
  });
}

Deno.test("restricted-model-types: model edit needs admin for every list spelling", async () => {
  await forEachTypeForm(async (repo) => {
    const model = await saveModel(repo, "edit-model");
    const tagsOf = async () =>
      (await repo.repoContext.definitionRepo.findByNameGlobal(model.name))
        ?.definition.tags;
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      const tagsBefore = await tagsOf();
      for (const modelIdOrName of [model.name, model.id]) {
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("model.edit", { modelIdOrName, content: retagged(model) }),
        );
        assert(
          refusedForAdmin(frames),
          `listed ${listed}, ${modelIdOrName}: ${JSON.stringify(frames)}`,
        );
      }
      assertEquals(await tagsOf(), tagsBefore, "the model is untouched");
      const admin = await sendRequest(
        createServeCtx(repo, ADMIN_GRANTS, options),
        request("model.edit", {
          modelIdOrName: model.name,
          content: retagged(model),
        }),
      );
      assertEquals(errorFrame(admin), undefined, JSON.stringify(admin));
    }
  });
});

Deno.test("restricted-model-types: model delete needs admin for every list spelling, by id or name", async () => {
  await forEachTypeForm(async (repo) => {
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      const model = await saveModel(repo, `delete-${crypto.randomUUID()}`);
      for (const modelIdOrName of [model.name, model.id]) {
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("model.delete", { modelIdOrName, force: true }),
        );
        assert(
          refusedForAdmin(frames),
          `listed ${listed}, ${modelIdOrName}: ${JSON.stringify(frames)}`,
        );
      }
      assert(
        await repo.repoContext.definitionRepo.findByNameGlobal(model.name),
        "the model is untouched",
      );
      const admin = await sendRequest(
        createServeCtx(repo, ADMIN_GRANTS, options),
        request("model.delete", { modelIdOrName: model.id, force: true }),
      );
      assertEquals(errorFrame(admin), undefined, JSON.stringify(admin));
    }
  });
});

Deno.test("restricted-model-types: deleting or renaming a restricted model's data needs admin", async () => {
  await forEachTypeForm(async (repo) => {
    const model = await saveModel(repo, "data-model");
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      const dataName = `d-${crypto.randomUUID().slice(0, 8)}`;
      await saveData(repo, model, dataName);
      const requests = [
        request("data.delete", { modelIdOrName: model.name, dataName }),
        request("data.rename", {
          modelIdOrName: model.id,
          oldName: dataName,
          newName: `${dataName}-renamed`,
        }),
      ];
      for (const req of requests) {
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          req,
        );
        assert(
          refusedForAdmin(frames),
          `listed ${listed}, ${req.type}: ${JSON.stringify(frames)}`,
        );
      }
      const versions = await repo.repoContext.unifiedDataRepo.listVersions(
        repo.modelType,
        model.id,
        dataName,
      );
      assertEquals(versions.length, 1, "the data is untouched");
      for (const req of requests.reverse()) {
        const admin = await sendRequest(
          createServeCtx(repo, ADMIN_GRANTS, options),
          { ...req, id: crypto.randomUUID() },
        );
        assertEquals(errorFrame(admin), undefined, JSON.stringify(admin));
      }
    }
  });
});

/** Saves a workflow running `model`'s noop, by name and as a direct step. */
async function saveStepWorkflow(
  repo: ServeRepo,
  model: Definition,
): Promise<Workflow> {
  const workflow = Workflow.fromData(
    {
      id: crypto.randomUUID(),
      name: `steps-${crypto.randomUUID().slice(0, 8)}`,
      version: 1,
      jobs: [{
        name: "main",
        steps: [
          {
            name: "by-name",
            task: {
              type: "model_method",
              modelIdOrName: model.name,
              methodName: "noop",
              inputs: { note: "stored" },
            },
          },
          {
            name: "direct",
            task: {
              type: "model_method",
              modelType: repo.modelType.normalized,
              modelName: model.name,
              methodName: "noop",
              inputs: { note: "stored" },
            },
          },
        ],
      }],
    } as unknown as Parameters<typeof Workflow.fromData>[0],
  );
  await repo.repoContext.workflowRepo.save(workflow);
  return workflow;
}

Deno.test("restricted-model-types: changing a stored workflow step that runs the type needs admin", async () => {
  await forEachTypeForm(async (repo) => {
    const model = await saveModel(repo, "step-model");
    const workflow = await saveStepWorkflow(repo, model);
    const base = JSON.parse(JSON.stringify(workflow.toData()));
    const edits: Record<string, (data: typeof base) => void> = {
      "by-name inputs": (d) => d.jobs[0].steps[0].task.inputs.note = "changed",
      "direct inputs": (d) => d.jobs[0].steps[1].task.inputs.note = "changed",
      "renamed step": (d) => d.jobs[0].steps[0].name = "renamed",
    };
    for (const listed of listedSpellings(repo)) {
      const options = { restrictedModelTypes: restrictedList(listed) };
      for (const [label, edit] of Object.entries(edits)) {
        const edited = structuredClone(base);
        edit(edited);
        const frames = await sendRequest(
          createServeCtx(repo, USER_GRANTS, options),
          request("workflow.edit", {
            workflowIdOrName: workflow.id,
            content: stringifyYaml(edited),
          }),
        );
        const error = errorFrame(frames);
        assertEquals(
          error?.error?.code,
          "unauthorized",
          JSON.stringify(frames),
        );
        assert(
          error!.error!.message.includes("a workflow step changed here runs"),
          `listed ${listed}, ${label}: ${error!.error!.message}`,
        );
      }
    }
    const options = {
      restrictedModelTypes: restrictedList(repo.modelType.normalized),
    };
    const edited = structuredClone(base);
    edited.jobs[0].steps[0].task.inputs.note = "changed by admin";
    const admin = await sendRequest(
      createServeCtx(repo, ADMIN_GRANTS, options),
      request("workflow.edit", {
        workflowIdOrName: workflow.id,
        content: stringifyYaml(edited),
      }),
    );
    assertEquals(errorFrame(admin), undefined, JSON.stringify(admin));
  });
});

Deno.test("restricted-model-types: a workflow edit leaving restricted steps alone stays open to non-admins", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "step-model");
    const workflow = await saveStepWorkflow(repo, model);
    const child = await saveStepWorkflow(repo, model);
    const options = {
      restrictedModelTypes: restrictedList(repo.modelType.normalized),
    };
    const edited = JSON.parse(JSON.stringify(workflow.toData()));
    edited.tags = { team: "ops" };
    edited.jobs[0].steps.unshift({
      name: "nested",
      task: { type: "workflow", workflowIdOrName: child.name },
    });
    const frames = await sendRequest(
      createServeCtx(repo, USER_GRANTS, options),
      request("workflow.edit", {
        workflowIdOrName: workflow.id,
        content: stringifyYaml(edited),
      }),
    );
    assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  }, { scopedType: true });
});

Deno.test("restricted-model-types: non-admins still read a restricted model, and edit and delete an unlisted one", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "read-model");
    const restricted = {
      restrictedModelTypes: restrictedList(repo.modelType.normalized),
    };
    const read = await sendRequest(
      createServeCtx(repo, USER_GRANTS, restricted),
      request("model.get", { modelIdOrName: model.name }),
    );
    assertEquals(errorFrame(read), undefined, JSON.stringify(read));

    const unlisted = { restrictedModelTypes: restrictedList("@other/type") };
    const edit = await sendRequest(
      createServeCtx(repo, USER_GRANTS, unlisted),
      request("model.edit", {
        modelIdOrName: model.name,
        content: retagged(model),
      }),
    );
    assertEquals(errorFrame(edit), undefined, JSON.stringify(edit));
    const del = await sendRequest(
      createServeCtx(repo, USER_GRANTS, unlisted),
      request("model.delete", { modelIdOrName: model.name, force: true }),
    );
    assertEquals(errorFrame(del), undefined, JSON.stringify(del));
  }, { scopedType: true });
});
