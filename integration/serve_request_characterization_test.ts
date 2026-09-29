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
  saveOutput,
  saveRun,
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

// Output and run reads (swamp-club#2673), pinned against the handlers before
// they moved to resolve-then-authorize. Each output or run id below starts
// with a hex prefix shared by two of them, so a short prefix is ambiguous and
// a longer one names exactly one.

const OUTPUT_A = "abc00000-0000-4000-8000-000000000001";
const OUTPUT_B = "abc11111-0000-4000-8000-000000000001";
const RUN_A = "abd00000-0000-4000-8000-000000000001";
const RUN_B = "abd11111-0000-4000-8000-000000000001";

async function historyFixtures(repo: ServeRepo) {
  const { model, workflow } = await fixtures(repo);
  await saveModel(repo, "empty-model");
  await saveWorkflow(repo, "empty-flow", model);
  await saveOutput(repo, model, OUTPUT_A);
  await saveOutput(repo, model, OUTPUT_B);
  await saveRun(repo, workflow, RUN_A);
  await saveRun(repo, workflow, RUN_B);
  return { model, workflow };
}

/** The request types that read an output or run, and the field naming it. */
const HISTORY_READS = [
  ["model.output.get", "outputIdOrModelName"],
  ["model.method.history.get", "outputIdOrModelName"],
  ["model.method.history.logs", "outputIdOrModelName"],
  ["model.output.data", "outputIdArg"],
  ["model.output.logs", "outputIdArg"],
  ["workflow.history.get", "workflowIdOrName"],
  ["workflow.history.logs", "runIdOrWorkflow"],
] as const;

function historyRead(type: string, field: string, value: string) {
  return request(type, { [field]: value });
}

const outputOrModelNotFound = (value: string) =>
  `Output or model not found: ${value}`;
const invalidOutputId = (value: string) =>
  `Invalid output ID format: ${value}. ` +
  `Expected a UUID or partial ID (3+ hex characters).`;
const runOrWorkflowNotFound = (value: string) =>
  `No workflow run or workflow found: ${value}`;
const workflowHistoryNotFound = { reason: "not_found" };

/** Today's error for a string that names no output, run, model or workflow. */
function missingError(type: string, value: string): Record<string, unknown> {
  const hex = /^[0-9a-f-]{3,}$/i.test(value);
  switch (type) {
    case "model.output.get":
    case "model.method.history.get":
      return {
        code: `${type.replaceAll(".", "_")}_failed`,
        message: outputOrModelNotFound(value),
      };
    case "model.method.history.logs":
      return {
        code: "model_method_history_logs_failed",
        message: `No method run or model found: ${value}`,
      };
    case "model.output.data":
    case "model.output.logs":
      return {
        code: `${type.replaceAll(".", "_")}_failed`,
        message: hex ? `Output not found: ${value}` : invalidOutputId(value),
      };
    case "workflow.history.get":
      return {
        code: "workflow_history_get_failed",
        message: runOrWorkflowNotFound(value),
        details: {
          ...workflowHistoryNotFound,
          entityType: "Workflow run or workflow",
        },
      };
    default:
      return {
        code: "workflow_history_logs_failed",
        message: runOrWorkflowNotFound(value),
      };
  }
}

for (const missing of [MISSING_NAME, "fedcba", MISSING_ID]) {
  Deno.test(`serve characterization: an output or run read for ${missing} gets today's error frame`, async () => {
    await withServeRepo(async (repo) => {
      await historyFixtures(repo);
      const ctx = createServeCtx(repo);
      for (const [type, field] of HISTORY_READS) {
        const frames = await sendRequest(
          ctx,
          historyRead(type, field, missing),
          null,
        );
        assertEquals(frames.length, 1, type);
        assertEquals(
          errorFrame(frames)?.error,
          missingError(type, missing),
          type,
        );
      }
    });
  });
}

Deno.test("serve characterization: a model with no outputs and a workflow with no runs get today's error frames", async () => {
  await withServeRepo(async (repo) => {
    await historyFixtures(repo);
    const ctx = createServeCtx(repo);
    const cases: [string, string, string, Record<string, unknown>][] = [
      ["model.output.get", "outputIdOrModelName", "empty-model", {
        code: "model_output_get_failed",
        message: "Output not found: no outputs for model: empty-model",
      }],
      ["model.method.history.get", "outputIdOrModelName", "empty-model", {
        code: "model_method_history_get_failed",
        message: "Output not found: no outputs for model: empty-model",
      }],
      ["model.method.history.logs", "outputIdOrModelName", "empty-model", {
        code: "model_method_history_logs_failed",
        message: "Run not found: for model: empty-model",
      }],
      ["workflow.history.get", "workflowIdOrName", "empty-flow", {
        code: "workflow_history_get_failed",
        message: "Workflow run not found: no runs for workflow: empty-flow",
        details: { ...workflowHistoryNotFound, entityType: "Workflow run" },
      }],
      ["workflow.history.logs", "runIdOrWorkflow", "empty-flow", {
        code: "workflow_history_logs_failed",
        message: "Run not found: for workflow: empty-flow",
      }],
    ];
    for (const [type, field, value, expected] of cases) {
      const frames = await sendRequest(
        ctx,
        historyRead(type, field, value),
        null,
      );
      assertEquals(frames.length, 1, type);
      assertEquals(errorFrame(frames)?.error, expected, type);
    }
  });
});

Deno.test("serve characterization: an ambiguous output or run prefix gets today's error frame", async () => {
  await withServeRepo(async (repo) => {
    await historyFixtures(repo);
    const ctx = createServeCtx(repo);
    for (const [type, field] of HISTORY_READS) {
      const run = type.startsWith("workflow.");
      const prefix = run ? "abd" : "abc";
      const frames = await sendRequest(
        ctx,
        historyRead(type, field, prefix),
        null,
      );
      assertEquals(frames.length, 1, type);
      const error = errorFrame(frames)?.error as
        | { code: string; message: string; details?: unknown }
        | undefined;
      assertEquals(error?.code, `${type.replaceAll(".", "_")}_failed`, type);
      // The matches are listed in scan order, which the filesystem decides.
      const [head, ...ids] = error!.message.split("\n");
      assertEquals(head, `Ambiguous ID prefix "${prefix}" matches:`, type);
      assertEquals(
        ids.map((id) => id.trim()).sort(),
        run ? [RUN_A, RUN_B] : [OUTPUT_A, OUTPUT_B],
        type,
      );
      if (type === "workflow.history.get") {
        assertEquals(error?.details, { reason: "validation_failed" });
      } else {
        assertEquals(error?.details, undefined, type);
      }
    }
  });
});

Deno.test("serve characterization: output and run reads by prefix, full id and name read today's entity", async () => {
  await withServeRepo(async (repo) => {
    const { model, workflow } = await historyFixtures(repo);
    const ctx = createServeCtx(repo);
    const cases: [
      string,
      string,
      string,
      (data: Record<string, unknown>) => unknown,
      unknown,
    ][] = [
      [
        "model.output.get",
        "outputIdOrModelName",
        "abc00",
        (d) => d.id,
        OUTPUT_A,
      ],
      [
        "model.output.get",
        "outputIdOrModelName",
        OUTPUT_A,
        (d) => d.id,
        OUTPUT_A,
      ],
      // By name or model id: the model's latest output.
      [
        "model.output.get",
        "outputIdOrModelName",
        "dev-model",
        (d) => d.id,
        OUTPUT_B,
      ],
      [
        "model.output.get",
        "outputIdOrModelName",
        model.id,
        (d) => d.id,
        OUTPUT_B,
      ],
      [
        "model.method.history.get",
        "outputIdOrModelName",
        "abc00",
        (d) => d.id,
        OUTPUT_A,
      ],
      [
        "model.method.history.get",
        "outputIdOrModelName",
        "dev-model",
        (d) => d.id,
        OUTPUT_B,
      ],
      [
        "model.method.history.logs",
        "outputIdOrModelName",
        "abc00",
        (d) => (d.info as { outputId: string }).outputId,
        OUTPUT_A,
      ],
      [
        "model.method.history.logs",
        "outputIdOrModelName",
        "dev-model",
        (d) => (d.info as { outputId: string }).outputId,
        OUTPUT_B,
      ],
      [
        "model.output.data",
        "outputIdArg",
        "abc00",
        (d) => d.outputId,
        OUTPUT_A,
      ],
      [
        "model.output.data",
        "outputIdArg",
        OUTPUT_B,
        (d) => d.outputId,
        OUTPUT_B,
      ],
      ["model.output.logs", "outputIdArg", "abc00", (d) => d.lines, [
        '{"value":"log"}',
      ]],
      ["workflow.history.get", "workflowIdOrName", "abd00", (d) => d.id, RUN_A],
      ["workflow.history.get", "workflowIdOrName", RUN_A, (d) => d.id, RUN_A],
      [
        "workflow.history.get",
        "workflowIdOrName",
        "dev-flow",
        (d) => d.workflowName,
        "dev-flow",
      ],
      [
        "workflow.history.get",
        "workflowIdOrName",
        workflow.id,
        (d) => d.workflowName,
        "dev-flow",
      ],
      [
        "workflow.history.logs",
        "runIdOrWorkflow",
        "abd00",
        (d) => (d.info as { runId: string }).runId,
        RUN_A,
      ],
      [
        "workflow.history.logs",
        "runIdOrWorkflow",
        "dev-flow",
        (d) => d.type,
        "no_log_file",
      ],
    ];
    for (const [type, field, value, pick, expected] of cases) {
      const frames = await sendRequest(
        ctx,
        historyRead(type, field, value),
        null,
      );
      assertEquals(
        frames.map((frame) => frame.type),
        [type],
        `${type} ${value}`,
      );
      const data = frames[0].payload?.data as Record<string, unknown>;
      assertEquals(pick(data), expected, `${type} ${value}`);
    }
  });
});
