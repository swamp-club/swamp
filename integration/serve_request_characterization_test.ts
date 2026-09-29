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
 * Pins what the single-resource serve handlers send back for a missing
 * resource and for an allowed request, by name and by id. Written against the
 * handlers before swamp-club#2674 moved them to resolve-then-authorize, so
 * that change must leave every frame here untouched.
 */

import { assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  saveData,
  saveModel,
  saveWorkflow,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const MISSING_NAME = "no-such-thing";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

function request(type: string, payload: Record<string, unknown>) {
  return { type, id: crypto.randomUUID(), payload };
}

/** Each frame as `[type, event kind or error code]`, for run streams. */
function shape(frames: Frame[]): [string, string][] {
  return frames.map((frame) => {
    const event = frame.event as { kind?: string } | undefined;
    return [frame.type, event?.kind ?? frame.error?.code ?? ""];
  });
}

function streamError(frames: Frame[]): unknown {
  const event = frames.find((frame) =>
    (frame.event as { kind?: string } | undefined)?.kind === "error"
  )?.event as { error?: unknown } | undefined;
  return event?.error;
}

async function fixtures(repo: ServeRepo) {
  const model = await saveModel(repo, "dev-model");
  await saveData(repo, model, "state");
  const workflow = await saveWorkflow(repo, "dev-flow", model);
  return { model, workflow };
}

function modelNotFound(idOrName: string) {
  return `Model not found: ${idOrName}`;
}

function workflowNotFound(idOrName: string) {
  return `Workflow not found: ${idOrName}`;
}

const dataNotFoundDetails = { reason: "not_found", entityType: "Model" };

for (const missing of [MISSING_NAME, MISSING_ID]) {
  const label = missing === MISSING_ID ? "by id" : "by name";

  Deno.test(`serve characterization: a missing model ${label} gets today's error frame`, async () => {
    await withServeRepo(async (repo) => {
      await fixtures(repo);
      const ctx = createServeCtx(repo);
      const cases: [
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ][] = [
        [
          "model.method.describe",
          { modelIdOrName: missing, methodName: "noop" },
          {
            code: "model_method_describe_failed",
            message: modelNotFound(missing),
          },
        ],
        ["model.get", { modelIdOrName: missing }, {
          code: "model_get_failed",
          message: modelNotFound(missing),
        }],
        ["model.validate", { modelIdOrName: missing }, {
          code: "model_validate_failed",
          message: modelNotFound(missing),
        }],
        ["model.evaluate", { modelIdOrName: missing }, {
          code: "model_evaluate_failed",
          message: modelNotFound(missing),
        }],
        ["data.get", { modelIdOrName: missing, dataName: "state" }, {
          code: "data_get_failed",
          message: modelNotFound(missing),
          details: dataNotFoundDetails,
        }],
        ["data.list", { modelIdOrName: missing }, {
          code: "data_list_failed",
          message: modelNotFound(missing),
          details: dataNotFoundDetails,
        }],
        ["data.versions", { modelIdOrName: missing, dataName: "state" }, {
          code: "data_versions_failed",
          message: modelNotFound(missing),
          details: dataNotFoundDetails,
        }],
        [
          "data.rename",
          { modelIdOrName: missing, oldName: "state", newName: "renamed" },
          { code: "data_rename_failed", message: modelNotFound(missing) },
        ],
        ["data.delete", { modelIdOrName: missing, dataName: "state" }, {
          code: "data_delete_failed",
          message: modelNotFound(missing),
        }],
      ];
      for (const [type, payload, expected] of cases) {
        const frames = await sendRequest(ctx, request(type, payload), null);
        assertEquals(frames.length, 1, type);
        assertEquals(errorFrame(frames)?.error, expected, type);
      }

      // model.delete's message is not pinned: it renders as
      // "[object Object]" today (swamp-club#2716).
      const deleted = await sendRequest(
        ctx,
        request("model.delete", { modelIdOrName: missing }),
        null,
      );
      assertEquals(errorFrame(deleted)?.error?.code, "model_delete_failed");
    });
  });

  Deno.test(`serve characterization: a missing workflow ${label} gets today's error frame`, async () => {
    await withServeRepo(async (repo) => {
      await fixtures(repo);
      const ctx = createServeCtx(repo);
      const cases: [string, Record<string, unknown>, string][] = [
        ["workflow.get", { workflowIdOrName: missing }, "workflow_get_failed"],
        [
          "workflow.validate",
          { workflowIdOrName: missing },
          "workflow_validate_failed",
        ],
        [
          "workflow.evaluate",
          { workflowIdOrName: missing },
          "workflow_evaluate_failed",
        ],
        [
          "workflow.approve",
          { workflowIdOrName: missing, stepName: "gate" },
          "workflow_approve_failed",
        ],
        [
          "workflow.reject",
          { workflowIdOrName: missing, stepName: "gate" },
          "workflow_reject_failed",
        ],
        [
          "workflow.resume",
          { workflowIdOrName: missing },
          "workflow_resume_failed",
        ],
        [
          "workflow.delete",
          { workflowIdOrName: missing },
          "workflow_delete_failed",
        ],
      ];
      for (const [type, payload, code] of cases) {
        const frames = await sendRequest(ctx, request(type, payload), null);
        assertEquals(frames.length, 1, type);
        assertEquals(
          errorFrame(frames)?.error,
          { code, message: workflowNotFound(missing) },
          type,
        );
      }
    });
  });

  Deno.test(`serve characterization: triggers for a missing workflow ${label} still succeed`, async () => {
    await withServeRepo(async (repo) => {
      await fixtures(repo);
      const ctx = createServeCtx(repo);
      for (
        const [type, payload] of [
          [
            "workflow.trigger.set",
            { workflowName: missing, schedule: "0 * * * *" },
          ],
          ["workflow.trigger.get", { workflowName: missing }],
          ["workflow.trigger.remove", { workflowName: missing }],
        ] as const
      ) {
        const frames = await sendRequest(ctx, request(type, payload), null);
        assertEquals(frames.map((frame) => frame.type), [type], type);
      }
    });
  });

  for (const detached of [false, true]) {
    const mode = detached ? "detached" : "inline";

    Deno.test(`serve characterization: running a missing model ${label} (${mode}) streams today's error`, async () => {
      await withServeRepo(async (repo) => {
        await fixtures(repo);
        const ctx = createServeCtx(repo, undefined, { detached });
        const frames = await sendRequest(
          ctx,
          request("model.method.run", {
            modelIdOrName: missing,
            methodName: "noop",
          }),
          null,
        );
        assertEquals(shape(frames), [
          ...(detached
            ? [["event", "run.accepted"]] as [string, string][]
            : []),
          ["event", "validating_inputs"],
          ["event", "resolving_model"],
          ["event", "error"],
          ["done", ""],
        ]);
        assertEquals(streamError(frames), {
          code: "model_not_found",
          message: modelNotFound(missing),
        });
      });
    });

    Deno.test(`serve characterization: running a missing workflow ${label} (${mode}) streams today's error`, async () => {
      await withServeRepo(async (repo) => {
        await fixtures(repo);
        const ctx = createServeCtx(repo, undefined, { detached });
        const frames = await sendRequest(
          ctx,
          request("workflow.run", { workflowIdOrName: missing }),
          null,
        );
        assertEquals(shape(frames), [
          ["event", "validating_inputs"],
          ["event", "error"],
          ["done", ""],
        ]);
        assertEquals(streamError(frames), {
          code: "workflow_not_found",
          message: `${workflowNotFound(missing)}.\n` +
            `Create it with 'swamp workflow create ${missing}', ` +
            `or run 'swamp doctor workflows --json' to check for broken workflow files`,
        });
      });
    });
  }
}

Deno.test("serve characterization: allowed requests by name succeed", async () => {
  await withServeRepo(async (repo) => {
    await fixtures(repo);
    const ctx = createServeCtx(repo);
    for (
      const [type, payload] of [
        ["model.method.describe", {
          modelIdOrName: "dev-model",
          methodName: "noop",
        }],
        ["model.get", { modelIdOrName: "dev-model" }],
        ["model.validate", { modelIdOrName: "dev-model" }],
        ["model.evaluate", { modelIdOrName: "dev-model" }],
        ["data.get", { modelIdOrName: "dev-model", dataName: "state" }],
        ["data.list", { modelIdOrName: "dev-model" }],
        ["data.versions", { modelIdOrName: "dev-model", dataName: "state" }],
        ["workflow.get", { workflowIdOrName: "dev-flow" }],
        ["workflow.validate", { workflowIdOrName: "dev-flow" }],
        ["workflow.evaluate", { workflowIdOrName: "dev-flow" }],
        ["workflow.trigger.set", {
          workflowName: "dev-flow",
          schedule: "0 * * * *",
        }],
        ["workflow.trigger.get", { workflowName: "dev-flow" }],
        ["workflow.trigger.remove", { workflowName: "dev-flow" }],
      ] as const
    ) {
      const frames = await sendRequest(ctx, request(type, payload), null);
      assertEquals(frames.map((frame) => frame.type), [type], type);
    }
  });
});

Deno.test("serve characterization: allowed requests by id succeed", async () => {
  await withServeRepo(async (repo) => {
    const { model, workflow } = await fixtures(repo);
    const ctx = createServeCtx(repo);
    for (
      const [type, payload] of [
        ["model.get", { modelIdOrName: model.id }],
        ["data.list", { modelIdOrName: model.id }],
        ["workflow.get", { workflowIdOrName: workflow.id }],
        ["workflow.validate", { workflowIdOrName: workflow.id }],
      ] as const
    ) {
      const frames = await sendRequest(ctx, request(type, payload), null);
      assertEquals(frames.map((frame) => frame.type), [type], type);
    }
  });
});

for (const detached of [false, true]) {
  const mode = detached ? "detached" : "inline";

  Deno.test(`serve characterization: running an allowed model and workflow by name (${mode}) completes`, async () => {
    await withServeRepo(async (repo) => {
      await fixtures(repo);
      const ctx = createServeCtx(repo, undefined, { detached });
      const modelRun = await sendRequest(
        ctx,
        request("model.method.run", {
          modelIdOrName: "dev-model",
          methodName: "noop",
        }),
        null,
      );
      assertEquals(streamError(modelRun), undefined);
      assertEquals(shape(modelRun).slice(-2), [
        ["event", "completed"],
        ["done", ""],
      ]);

      const workflowRun = await sendRequest(
        ctx,
        request("workflow.run", { workflowIdOrName: "dev-flow" }),
        null,
      );
      assertEquals(streamError(workflowRun), undefined);
      assertEquals(shape(workflowRun).slice(-2), [
        ["event", "completed"],
        ["done", ""],
      ]);
    });
  });
}

Deno.test("serve characterization: running an allowed workflow by id completes", async () => {
  await withServeRepo(async (repo) => {
    const { workflow } = await fixtures(repo);
    const ctx = createServeCtx(repo);
    const frames = await sendRequest(
      ctx,
      request("workflow.run", { workflowIdOrName: workflow.id }),
      null,
    );
    assertEquals(streamError(frames), undefined);
    assertEquals(shape(frames).slice(-2), [["event", "completed"], [
      "done",
      "",
    ]]);
  });
});
