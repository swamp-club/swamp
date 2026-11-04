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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import {
  EngineProfileError,
  validateEngineWorkflow,
} from "../src/engine/profile.ts";
import { handleMessage } from "../src/serve/connection.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { SessionReply } from "../src/serve/session.ts";
import type { ServerMessage } from "../src/serve/protocol.ts";
import {
  CALLER,
  createServeCtx,
  grant,
  saveData,
  saveModel,
  saveWorkflow,
  sendRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

class RecordingSession implements SessionReply {
  readonly kind = "session-reply";
  open = true;
  readonly messages: ServerMessage[] = [];
  onSend?: (message: ServerMessage) => void;
  send(message: ServerMessage): void {
    this.messages.push(message);
    this.onSend?.(message);
  }
  close(): void {
    this.open = false;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

async function dispatch(
  ctx: ConnectionContext,
  session: RecordingSession,
  request: Record<string, unknown>,
  active = new Map<string, AbortController>(),
  principal = CALLER,
): Promise<void> {
  await handleMessage(
    session,
    ctx,
    active,
    new MessageEvent("message", { data: JSON.stringify(request) }),
    principal,
  );
  await session.flush();
}

Deno.test("serve session port: data query retains WebSocket authorization and isolates matching request ids", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "visible");
    await saveData(repo, model, "state");
    const ctx = createServeCtx(repo, [
      grant({ resource: { kind: "data", pattern: "*" } }),
    ]);
    const request = {
      type: "data.query",
      id: "same-id",
      payload: { predicate: "true" },
    };
    const legacy = await sendRequest(ctx, request);
    const allowed = new RecordingSession();
    const denied = new RecordingSession();
    await Promise.all([
      dispatch(ctx, allowed, request),
      dispatch(ctx, denied, request, undefined, { kind: "user", id: "other" }),
    ]);
    assertEquals<unknown>(allowed.messages, legacy);
    assertEquals(allowed.messages[0].type, "data.query");
    assertEquals(denied.messages.length, 1);
    assertEquals(denied.messages[0].type, "error");
    if (denied.messages[0].type === "error") {
      assertEquals(denied.messages[0].error.code, "unauthorized");
    }
  });
});

Deno.test("serve session port: a finite detached workflow persists after its session closes", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "work");
    const workflow = await saveWorkflow(repo, "finite", model);
    const ctx = createServeCtx(repo, undefined, { detached: true });
    ctx.validateWorkflow = validateEngineWorkflow;
    const active = new Map<string, AbortController>();
    const session = new RecordingSession();
    let runId: string | undefined;
    session.onSend = (message) => {
      if (message.type === "event" && message.event.kind === "started") {
        runId = message.event.runId as string;
        session.close();
        for (const controller of active.values()) controller.abort();
      }
    };
    await dispatch(ctx, session, {
      type: "workflow.run",
      id: "detached",
      payload: { workflowIdOrName: workflow.name },
    }, active);
    await waitFor(
      () => ctx.activeRunRegistry!.size === 0,
      "detached run persisted completion",
    );
    assert(runId);
    const persisted = await repo.repoContext.workflowRunRepo.findById(
      workflow.id,
      createWorkflowRunId(runId),
    );
    assertEquals(persisted?.status, "succeeded");
    assertEquals(active.size, 0);
    assertEquals(session.messages.filter((m) => m.type === "done").length, 0);
  });
});

Deno.test("serve session port: cached unsupported steps are refused before a run is persisted", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "work");
    const workflow = await saveWorkflow(repo, "cached", model);
    const cached = Workflow.create({
      id: workflow.id,
      name: workflow.name,
      jobs: [
        Job.create({
          name: "main",
          steps: [
            Step.create({
              name: "gate",
              task: StepTask.manualApproval("Approve"),
            }),
          ],
        }),
      ],
    });
    await new YamlEvaluatedWorkflowRepository(repo.repoDir).save(
      cached,
      undefined,
    );
    const ctx = createServeCtx(repo, undefined, { detached: true });
    ctx.validateWorkflow = validateEngineWorkflow;
    const session = new RecordingSession();
    await dispatch(ctx, session, {
      type: "workflow.run",
      id: "cached",
      payload: { workflowIdOrName: workflow.name, lastEvaluated: true },
    });
    assertEquals(
      session.messages.some((m) =>
        m.type === "event" && m.event.kind === "started"
      ),
      false,
    );
    const refusal = session.messages.find((m) =>
      m.type === "event" && m.event.kind === "error"
    );
    assert(refusal?.type === "event");
    assertEquals(
      (refusal.event.error as { code: string }).code,
      "unsupported_profile",
    );
    assertEquals(
      (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(workflow.id))
        .length,
      0,
    );
    assertEquals(ctx.activeRunRegistry!.size, 0);

    // The service also validates a cache loaded without the application layer.
    const deps = await createWorkflowRunDeps(
      repo.repoDir,
      repo.repoContext,
      repo.datastoreConfig,
    );
    const service = deps.createExecutionService(
      deps.workflowRepo,
      deps.runRepo,
      deps.repoDir,
      deps.catalogStore,
    );
    await assertRejects(async () => {
      for await (
        const _event of service.run(workflow.name, {
          lastEvaluated: true,
          validateWorkflow: validateEngineWorkflow,
        })
      ) { /* The unsupported cache must fail before a run starts. */ }
    }, EngineProfileError);
    assertEquals(
      (await repo.repoContext.workflowRunRepo.findAllByWorkflowId(workflow.id))
        .length,
      0,
    );
  });
});
