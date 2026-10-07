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
 * extension type listed as `@x/y`, `x/y` or `@X::Y` (swamp-club#3129). Runs
 * through `handleMessage` against a real repository.
 */

import { assert, assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { buildServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveModel,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

const USER_GRANTS = [
  grant({}),
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
  const scoped = repo.modelType.normalized;
  const bare = scoped.slice(1);
  return [scoped, bare, `@${bare.toUpperCase().replace("/", "::")}`];
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
