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
 * Serve's evaluate saves only what the caller may run (swamp-club#3940). A
 * later `--last-evaluated` run replays the saved evaluation, recorded inputs
 * included, so a caller who may only read gets the evaluation back unsaved
 * and cannot change what a later run executes.
 */

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
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

const READ_ONLY: Grant[] = [
  grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "workflow", pattern: "*" } }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

const RUNNER: Grant[] = [
  grant({
    actions: ["read", "run"],
    resource: { kind: "model", pattern: "*" },
  }),
  grant({
    actions: ["read", "run"],
    resource: { kind: "workflow", pattern: "*" },
  }),
  grant({ actions: ["read"], resource: { kind: "data", pattern: "*" } }),
];

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** The evaluate reply's data, after asserting it is not an error. */
function replyData(frames: Frame[], label: string): Record<string, unknown> {
  assertEquals(errorFrame(frames), undefined, label);
  const reply = frames.find((f) => f.type.endsWith(".evaluate"));
  assert(reply?.payload, `${label}: no reply`);
  return reply.payload.data as Record<string, unknown>;
}

function workflowCache(repo: ServeRepo) {
  return new YamlEvaluatedWorkflowRepository(
    repo.repoDir,
    repo.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
  );
}

function definitionCache(repo: ServeRepo) {
  return new YamlEvaluatedDefinitionRepository(
    repo.repoDir,
    repo.datastoreResolver.resolvePath(SWAMP_SUBDIRS.definitionsEvaluated),
  );
}

async function evaluatedInputs(
  repo: ServeRepo,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const cache = await workflowCache(repo).findByNameWithProvenance(name);
  return cache?.evaluatedInputs;
}

Deno.test("serve evaluate: a read-only workflow.evaluate cannot plant the inputs a --last-evaluated run replays", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "target");
    await saveWorkflow(repo, "flow", model);
    const runner = createServeCtx(repo, RUNNER);
    const reader = createServeCtx(repo, READ_ONLY);

    const ran = replyData(
      await sendRequest(
        runner,
        request("workflow.evaluate", {
          workflowIdOrName: "flow",
          inputs: { msg: "runner-chose" },
        }),
      ),
      "runner evaluate",
    );
    assertEquals(ran.saved, undefined);
    assert(typeof ran.outputPath === "string");
    assertEquals(await evaluatedInputs(repo, "flow"), { msg: "runner-chose" });

    const read = replyData(
      await sendRequest(
        reader,
        request("workflow.evaluate", {
          workflowIdOrName: "flow",
          inputs: { msg: "reader-planted" },
        }),
      ),
      "reader evaluate",
    );
    assertEquals(read.saved, false);
    assertEquals(read.outputPath, undefined);
    assertEquals(read.name, "flow");
    assertEquals(await evaluatedInputs(repo, "flow"), { msg: "runner-chose" });
  });
});

Deno.test("serve evaluate: a read-only workflow.evaluate of every workflow saves none and still reports them", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "target");
    await saveWorkflow(repo, "flow-a", model);
    await saveWorkflow(repo, "flow-b", model);
    const reader = createServeCtx(repo, READ_ONLY);

    const data = replyData(
      await sendRequest(
        reader,
        request("workflow.evaluate", { inputs: { msg: "planted" } }),
      ),
      "reader evaluate all",
    );
    const items = data.items as Array<Record<string, unknown>>;
    assertEquals(items.map((i) => [i.name, i.saved]).sort(), [
      ["flow-a", false],
      ["flow-b", false],
    ]);
    assertEquals(await evaluatedInputs(repo, "flow-a"), undefined);
    assertEquals(await evaluatedInputs(repo, "flow-b"), undefined);
  });
});

async function cachedDefinition(
  repo: ServeRepo,
  definition: Definition,
): Promise<Definition | null> {
  return await definitionCache(repo).findById(repo.modelType, definition.id);
}

Deno.test("serve evaluate: a read-only model.evaluate does not write the evaluated definition a run replays", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "target");
    const reader = createServeCtx(repo, READ_ONLY);

    const read = replyData(
      await sendRequest(
        reader,
        request("model.evaluate", { modelIdOrName: "target" }),
      ),
      "reader evaluate",
    );
    assertEquals(read.saved, false);
    assertEquals(read.outputPath, undefined);
    assertEquals(await cachedDefinition(repo, model), null);

    const all = replyData(
      await sendRequest(reader, request("model.evaluate", {})),
      "reader evaluate all",
    );
    const items = all.items as Array<Record<string, unknown>>;
    assertEquals(items.map((i) => [i.name, i.saved]), [["target", false]]);
    assertEquals(await cachedDefinition(repo, model), null);

    const runner = createServeCtx(repo, RUNNER);
    const ran = replyData(
      await sendRequest(
        runner,
        request("model.evaluate", { modelIdOrName: "target" }),
      ),
      "runner evaluate",
    );
    assertEquals(ran.saved, undefined);
    assert(typeof ran.outputPath === "string");
    assert(await cachedDefinition(repo, model));
  });
});

Deno.test("serve evaluate: run granted only for a named method evaluates but does not save", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "target");
    // evaluate has no method, so the condition sees an empty methodName.
    const methodOnly = createServeCtx(repo, [
      grant({ actions: ["read"], resource: { kind: "model", pattern: "*" } }),
      grant({
        actions: ["run"],
        resource: { kind: "model", pattern: "*" },
        condition: 'methodName == "noop"',
      }),
    ]);

    const data = replyData(
      await sendRequest(
        methodOnly,
        request("model.evaluate", { modelIdOrName: "target" }),
      ),
      "method-only evaluate",
    );
    assertEquals(data.saved, false);
    assertEquals(await cachedDefinition(repo, model), null);
  });
});
