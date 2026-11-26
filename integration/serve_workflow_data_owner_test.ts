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

import { assertEquals } from "@std/assert";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveModel,
  saveRunStepData,
  saveRunWithData,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";

const WORKFLOW_READ = grant({
  actions: ["read"],
  resource: { kind: "workflow", pattern: "*" },
});

function dataRead(pattern: string, effect: "allow" | "deny" = "allow"): Grant {
  return grant({
    effect,
    actions: ["read"],
    resource: { kind: "data", pattern },
  });
}

async function orphanedWorkflowData(repo: ServeRepo): Promise<string> {
  const model = await saveModel(repo, "echoer");
  const workflow = await saveWorkflow(repo, "orphan-flow", model);
  const run = WorkflowRun.create(workflow);
  const data = await saveRunStepData(repo, model, run, "log");
  await saveRunWithData(repo, workflow, [data]);
  await repo.repoContext.definitionRepo.delete(
    repo.modelType,
    model.id,
    model.name,
  );
  return model.id;
}

function getOrphanLog(
  repo: ServeRepo,
  grants: Grant[],
): Promise<Frame[]> {
  return sendRequest(createServeCtx(repo, grants), {
    type: "data.get",
    id: crypto.randomUUID(),
    payload: { workflowName: "orphan-flow", dataName: "log" },
  });
}

Deno.test("serve data.get: workflow data whose behavior definition is gone is authorized under the behavior name it recorded", async () => {
  await withServeRepo(async (repo) => {
    const modelId = await orphanedWorkflowData(repo);

    const allowed = await getOrphanLog(repo, [
      WORKFLOW_READ,
      dataRead("echoer"),
    ]);
    assertEquals(errorFrame(allowed), undefined, JSON.stringify(allowed));
    const reply = allowed.find((frame) => frame.type === "data.get") as
      | Frame & {
        payload?: { data?: { modelId?: string; modelName?: string } };
      }
      | undefined;
    assertEquals(
      [reply?.payload?.data?.modelId, reply?.payload?.data?.modelName],
      [modelId, "echoer"],
    );

    const otherName = await getOrphanLog(repo, [
      WORKFLOW_READ,
      dataRead("another-behavior"),
    ]);
    assertEquals(errorFrame(otherName)?.error?.code, "unauthorized");
  });
});

Deno.test("serve data.get: a deny on a behavior name still refuses its workflow data once the definition is gone", async () => {
  await withServeRepo(async (repo) => {
    await orphanedWorkflowData(repo);

    const denied = await getOrphanLog(repo, [
      WORKFLOW_READ,
      dataRead("*"),
      dataRead("echoer", "deny"),
    ]);
    assertEquals(errorFrame(denied)?.error?.code, "unauthorized");
  });
});
