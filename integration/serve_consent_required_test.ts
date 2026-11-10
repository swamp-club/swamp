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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import type { DelegationLookup } from "../src/domain/access/delegation_directory.ts";
import type { DelegationRecord } from "../src/domain/models/access/delegation_model.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  CALLER,
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  saveGatedWorkflow,
  sendRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const CLIENT = "integration:app";

const WORKFLOWS = grant({
  actions: ["read", "run", "approve", "signal", "write"],
  resource: { kind: "workflow", pattern: "*" },
});

const READ_ONLY = grant({
  actions: ["read"],
  resource: { kind: "workflow", pattern: "*" },
});

function consented(actions: string[]): DelegationLookup {
  return {
    standingOf: () => ({
      kind: "standing",
      ceiling: Ceiling.parse({
        version: 1,
        ceiling: [{ actions, resource: "workflow:*" }],
      }),
    }),
    recordOf: (id) => ({ integrationId: id }) as DelegationRecord,
  };
}

function send(
  ctx: ConnectionContext,
  type: string,
  payload: Record<string, unknown>,
  client: string | undefined = CLIENT,
): Promise<Frame[]> {
  return sendRequest(ctx, { type, id: crypto.randomUUID(), payload }, CALLER, {
    client,
    awaitRuns: false,
  });
}

function codeOf(frames: Frame[]): string | undefined {
  return errorFrame(frames)?.error?.code;
}

Deno.test("consent_required: a delegated run, approve or read outside the consented ceiling but allowed by grants and the live ceiling", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "deploy", "gate");
    const ctx = createServeCtx(repo, [WORKFLOWS], {
      delegations: consented(["read"]),
    });
    const runFrames = await send(ctx, "workflow.run", {
      workflowIdOrName: "deploy",
    });
    assertEquals(
      codeOf(runFrames),
      "consent_required",
      JSON.stringify(runFrames),
    );
    assertEquals(
      codeOf(
        await send(ctx, "workflow.approve", {
          workflowIdOrName: "deploy",
          stepName: "gate",
        }),
      ),
      "consent_required",
    );
    // a refused signal reads as no wait at all, whatever refused it
    assertEquals(
      codeOf(
        await send(ctx, "workflow.signal", {
          workflow: "deploy",
          key: "a-key",
          payload: {},
        }),
      ),
      "not_found",
    );
    const readOnly = createServeCtx(repo, [WORKFLOWS], {
      delegations: consented(["run"]),
    });
    assertEquals(
      codeOf(
        await send(readOnly, "workflow.get", { workflowIdOrName: "deploy" }),
      ),
      "consent_required",
    );
  });
});

Deno.test("consent_required: never when grants refuse too, so a relink can't help", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "deploy", "gate");
    const ctx = createServeCtx(repo, [READ_ONLY], {
      delegations: consented(["read"]),
    });
    assertEquals(
      codeOf(await send(ctx, "workflow.run", { workflowIdOrName: "deploy" })),
      "unauthorized",
    );
  });
});

Deno.test("triggers and schedules: a delegated token can't set a workflow trigger or a schedule, even with a write grant", async () => {
  await withServeRepo(async (repo) => {
    await saveGatedWorkflow(repo, "deploy", "gate");
    const ctx = createServeCtx(repo, [WORKFLOWS], {
      delegations: consented(["approve", "read", "run", "signal"]),
    });
    const frames = await send(ctx, "workflow.trigger.set", {
      workflowName: "deploy",
      schedule: "*/5 * * * *",
    });
    assertEquals(codeOf(frames), "unauthorized", JSON.stringify(frames));
    const direct = await send(
      ctx,
      "workflow.trigger.set",
      { workflowName: "deploy", schedule: "*/5 * * * *" },
      "direct:token",
    );
    assert(errorFrame(direct) === undefined, JSON.stringify(direct));
  });
});
