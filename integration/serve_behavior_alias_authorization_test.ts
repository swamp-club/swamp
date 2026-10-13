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
 * The behavior spelling of workflow steps and grant selectors is translated
 * before serve authorizes a workflow edit (swamp-club#3334): a deny in either
 * spelling blocks a step in either spelling, re-spelling a stored step adds
 * nothing to authorize, and a step moved, copied or retargeted under the
 * behavior spelling is judged as it would be under the model spelling.
 */

import { assert, assertEquals } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { Workflow } from "../src/domain/workflows/workflow.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { parseResourceSelector } from "../src/domain/access/resource_selector.ts";
import { parseGrantFile } from "../src/domain/access/grant_file.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
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

await initializeLogging({});

const BASE_GRANTS: Grant[] = [
  grant({ resource: { kind: "model", pattern: "*" } }),
  grant({ resource: { kind: "workflow", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

/** A run deny on `selector`, read the way a grant file reads it. */
function denyFromGrantFile(selector: string): Grant {
  const parsed = parseGrantFile(
    "deny.yaml",
    `grants:\n  - subject: user:caller\n    effect: deny\n    actions: [run]\n    resource: "${selector}"\n`,
  );
  assertEquals(parsed.errors, [], selector);
  return grant({
    effect: "deny",
    actions: ["run"],
    resource: parsed.entries[0].resource,
  });
}

/** A run deny on `selector`, as `access grant create --on` parses it. */
function denyFromFlag(selector: string): Grant {
  return grant({
    effect: "deny",
    actions: ["run"],
    resource: parseResourceSelector(selector),
  });
}

type WorkflowJson = {
  jobs: { name: string; steps: Record<string, unknown>[] }[];
};

function workflowJson(workflow: Workflow): WorkflowJson {
  return JSON.parse(JSON.stringify(workflow.toData()));
}

function edit(
  ctx: ConnectionContext,
  workflow: Workflow,
  change: (data: WorkflowJson) => void,
): Promise<Frame[]> {
  const data = workflowJson(workflow);
  change(data);
  return sendRequest(ctx, {
    type: "workflow.edit",
    id: crypto.randomUUID(),
    payload: { workflowIdOrName: workflow.id, content: stringifyYaml(data) },
  });
}

function addStep(task: Record<string, unknown>, name = "added") {
  return (data: WorkflowJson) => {
    data.jobs[0].steps.push({ name, task });
  };
}

function assertRefused(frames: Frame[], label: string): void {
  const error = errorFrame(frames);
  assert(error, `${label}: expected a refusal`);
  assertEquals(error.error?.code, "unauthorized", label);
}

function assertAllowed(frames: Frame[], label: string): void {
  assertEquals(errorFrame(frames), undefined, label);
}

function directTask(
  spelling: "model" | "behavior",
  type: string,
  name: string,
) {
  return spelling === "behavior"
    ? {
      type: "behavior",
      behaviorType: type,
      behaviorName: name,
      methodName: "noop",
    }
    : {
      type: "model_method",
      modelType: type,
      modelName: name,
      methodName: "noop",
    };
}

function existingTask(spelling: "model" | "behavior", ref: string) {
  return spelling === "behavior"
    ? { type: "behavior", behavior: ref, methodName: "noop" }
    : { type: "model_method", modelIdOrName: ref, methodName: "noop" };
}

async function withFlow(
  fn: (repo: ServeRepo, flow: Workflow) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const dev = await saveModel(repo, "dev-db");
    await saveModel(repo, "locked-db");
    await saveModel(repo, "locked-2");
    await fn(repo, await saveWorkflow(repo, "editable", dev));
  }, { scopedType: true });
}

Deno.test("serve behavior spelling: a type deny in either spelling blocks a direct step in either spelling", async () => {
  await withFlow(async (repo, flow) => {
    const type = repo.modelType.normalized;
    // The baseline: without the deny, both spellings save. Each names its
    // own definition, so the steps checked below are new targets.
    for (const spelling of ["model", "behavior"] as const) {
      assertAllowed(
        await edit(
          createServeCtx(repo, BASE_GRANTS),
          flow,
          addStep(directTask(spelling, type, `baseline-${spelling}`)),
        ),
        `no deny, ${spelling} step`,
      );
    }
    const scope = `${type.split("/")[0]}/*`;
    for (const deny of [`behavior:${scope}`, `model:${scope}`]) {
      for (const make of [denyFromGrantFile, denyFromFlag]) {
        const ctx = createServeCtx(repo, [...BASE_GRANTS, make(deny)]);
        for (const spelling of ["model", "behavior"] as const) {
          assertRefused(
            await edit(
              ctx,
              flow,
              addStep(directTask(spelling, type, "fresh")),
            ),
            `${deny} (${make.name}) vs ${spelling} step`,
          );
        }
      }
    }
  });
});

Deno.test("serve behavior spelling: a name deny in either spelling blocks an existing-definition step in either spelling", async () => {
  await withFlow(async (repo, flow) => {
    for (const deny of ["behavior:locked-*", "model:locked-*"]) {
      const ctx = createServeCtx(repo, [
        ...BASE_GRANTS,
        denyFromGrantFile(deny),
      ]);
      for (const spelling of ["model", "behavior"] as const) {
        assertRefused(
          await edit(ctx, flow, addStep(existingTask(spelling, "locked-db"))),
          `${deny} vs ${spelling} step`,
        );
        assertAllowed(
          await edit(ctx, flow, addStep(existingTask(spelling, "dev-db"))),
          `${deny} vs ${spelling} step on an allowed model`,
        );
      }
    }
  });
});

Deno.test("serve behavior spelling: re-spelling a stored step adds nothing to authorize; retargeting it is judged", async () => {
  await withServeRepo(async (repo) => {
    const locked = await saveModel(repo, "locked-db");
    await saveModel(repo, "locked-2");
    await saveModel(repo, "dev-db");
    const ctx = createServeCtx(repo, [
      ...BASE_GRANTS,
      denyFromGrantFile("behavior:locked-*"),
    ]);
    // Stored by an admin: a step the caller may not run.
    const flow = await saveWorkflow(repo, "stored", locked);
    const respell = (ref: string) => (data: WorkflowJson) => {
      data.jobs[0].steps[0].task = existingTask("behavior", ref);
    };
    assertAllowed(
      await edit(ctx, flow, respell("locked-db")),
      "re-spelled, same target",
    );
    const saved = await repo.repoContext.workflowRepo.findById(flow.id);
    assertEquals(saved?.jobs[0].steps[0].task.data, {
      type: "model_method",
      modelIdOrName: "locked-db",
      methodName: "noop",
    });
    assertRefused(
      await edit(ctx, flow, respell("locked-2")),
      "re-spelled onto a new denied target",
    );
  });
});

Deno.test("serve behavior spelling: a stored step copied or moved under the behavior spelling is judged as under the model spelling", async () => {
  await withServeRepo(async (repo) => {
    const stored = await saveModel(repo, "stored-db");
    const flow = await saveWorkflow(repo, "stored", stored);
    const outcome = (frames: Frame[]) =>
      errorFrame(frames)?.error?.code ?? "ok";
    const copy = (spelling: "model" | "behavior") =>
      addStep(existingTask(spelling, "stored-db"), "copy");
    const move = (spelling: "model" | "behavior") => (data: WorkflowJson) => {
      const [step] = data.jobs[0].steps.splice(0, 1);
      data.jobs[0].steps.push({
        ...step,
        name: "moved",
        task: existingTask(spelling, "stored-db"),
      });
    };
    // A changed step on a restricted type needs admin (swamp-club#3131): a
    // copy or move is a changed step, in either spelling.
    const restricted = createServeCtx(repo, BASE_GRANTS, {
      restrictedModelTypes: [repo.modelType.normalized],
    });
    for (const spelling of ["model", "behavior"] as const) {
      assertRefused(
        await edit(restricted, flow, copy(spelling)),
        `${spelling} copy`,
      );
      assertRefused(
        await edit(restricted, flow, move(spelling)),
        `${spelling} move`,
      );
    }
    // Under a plain deny, whatever the model spelling gets, the behavior
    // spelling gets.
    const denied = createServeCtx(repo, [
      ...BASE_GRANTS,
      denyFromFlag("behavior:stored-*"),
    ]);
    for (const change of [copy, move]) {
      assertEquals(
        outcome(await edit(denied, flow, change("behavior"))),
        outcome(await edit(denied, flow, change("model"))),
        change.name,
      );
    }
  });
});
