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
 * A model: deny matches the type it names whatever its spelling — case,
 * `::` or `.` separators, with or without a leading `@` — on model create,
 * method run, model edit and adding a workflow step; an allow matches only
 * as written, so a misspelled allow grants nothing (swamp-club#3130). Runs
 * through `handleMessage` against a real repository, as a non-admin.
 */

import { assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
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

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** Spellings of the repo's `@test/serve-…` type, none of them canonical. */
function selectorSpellings(repo: ServeRepo): string[] {
  const scoped = repo.modelType.normalized;
  const bare = scoped.slice(1);
  const [collective, name] = bare.split("/");
  return [
    `@${collective.toUpperCase()}/${name.toUpperCase()}`,
    bare,
    `@${collective}::${name}`,
    `${collective.toUpperCase()}.${name}`,
    `@${collective.toUpperCase()}/*`,
    `${collective}::*`,
  ];
}

const ALLOW_WORKFLOWS = grant({ resource: { kind: "workflow", pattern: "*" } });

function denyGrants(pattern: string): Grant[] {
  return [
    grant({}),
    ALLOW_WORKFLOWS,
    grant({ effect: "deny", resource: { kind: "model", pattern } }),
  ];
}

function assertRefused(frames: Frame[], label: string) {
  assertEquals(
    errorFrame(frames)?.error?.code,
    "unauthorized",
    `${label}: ${JSON.stringify(frames)}`,
  );
}

/** Sends each serve path that acts on a model of the repo's type. */
async function sendEachPath(
  repo: ServeRepo,
  grants: Grant[],
): Promise<Record<string, Frame[]>> {
  const ctx = createServeCtx(repo, grants);
  const model = await saveModel(repo, `m-${crypto.randomUUID().slice(0, 8)}`);
  const other = await saveModel(repo, `o-${crypto.randomUUID().slice(0, 8)}`);
  // Saved without authorization, so only the step added below is checked.
  const workflow = await saveWorkflow(
    repo,
    `w-${crypto.randomUUID().slice(0, 8)}`,
    other,
  );
  const edited = JSON.parse(JSON.stringify(workflow.toData()));
  edited.jobs[0].steps.push({
    name: "added",
    task: {
      type: "model_method",
      modelIdOrName: model.name,
      methodName: "noop",
    },
  });
  return {
    create: await sendRequest(
      ctx,
      request("model.create", {
        typeArg: repo.modelType.normalized,
        name: `n-${crypto.randomUUID().slice(0, 8)}`,
      }),
    ),
    run: await sendRequest(
      ctx,
      request("model.method.run", {
        modelIdOrName: model.name,
        methodName: "noop",
      }),
    ),
    edit: await sendRequest(
      ctx,
      request("model.edit", {
        modelIdOrName: model.name,
        content: stringifyYaml({
          ...JSON.parse(JSON.stringify(model.toData())),
          tags: { edited: "true" },
        }),
      }),
    ),
    "workflow step": await sendRequest(
      ctx,
      request("workflow.edit", {
        workflowIdOrName: workflow.id,
        content: stringifyYaml(edited),
      }),
    ),
  };
}

Deno.test("grant type spelling: a deny in any spelling refuses create, run, edit and workflow step", async () => {
  await withServeRepo(async (repo) => {
    for (const pattern of selectorSpellings(repo)) {
      const sent = await sendEachPath(repo, denyGrants(pattern));
      for (const [path, frames] of Object.entries(sent)) {
        assertRefused(frames, `deny model:${pattern}, ${path}`);
      }
    }
  }, { scopedType: true });
});

Deno.test("grant type spelling: the paths are open without the deny", async () => {
  await withServeRepo(async (repo) => {
    const sent = await sendEachPath(repo, [grant({}), ALLOW_WORKFLOWS]);
    for (const [path, frames] of Object.entries(sent)) {
      assertEquals(
        errorFrame(frames),
        undefined,
        `${path}: ${JSON.stringify(frames)}`,
      );
    }
  }, { scopedType: true });
});

Deno.test("grant type spelling: a misspelled allow grants nothing, a canonical one grants", async () => {
  await withServeRepo(async (repo) => {
    for (const pattern of selectorSpellings(repo)) {
      const sent = await sendEachPath(repo, [
        ALLOW_WORKFLOWS,
        grant({ resource: { kind: "model", pattern } }),
      ]);
      for (const [path, frames] of Object.entries(sent)) {
        assertRefused(frames, `allow model:${pattern}, ${path}`);
      }
    }
    const sent = await sendEachPath(repo, [
      ALLOW_WORKFLOWS,
      grant({
        resource: { kind: "model", pattern: repo.modelType.normalized },
      }),
    ]);
    for (const [path, frames] of Object.entries(sent)) {
      assertEquals(
        errorFrame(frames),
        undefined,
        `${path}: ${JSON.stringify(frames)}`,
      );
    }
  }, { scopedType: true });
});
