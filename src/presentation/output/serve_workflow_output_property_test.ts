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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import type { WorkflowRunEvent } from "../../libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type { WorkflowSignalData } from "../../libswamp/workflows/signal.ts";
import type { WorkflowWaitsData } from "../../libswamp/workflows/waits.ts";
import type { PendingApproval } from "../../libswamp/workflows/approvals.ts";
import type { WorkflowApproveData } from "../../libswamp/workflows/approve.ts";
import type {
  AwaitingParentData,
  DetachedNestedRunData,
} from "../../libswamp/workflows/nested_runs.ts";
import {
  createWorkflowRunRenderer,
  type RenderClock,
} from "../renderers/workflow_run.ts";
import { renderWorkflowRunDisplay } from "../renderers/workflow_run_display.ts";
import { createWorkflowCreateRenderer } from "../renderers/workflow_create.ts";
import { createWorkflowDoctorRenderer } from "../renderers/workflow_doctor.ts";
import { createWorkflowValidateRenderer } from "../renderers/workflow_validate.ts";
import { createWorkflowHistoryLogsRenderer } from "../renderers/workflow_history_logs.ts";
import { renderWorkflowGraph } from "../renderers/workflow_graph.ts";
import { inputPairs } from "../renderers/run_input_pairs.ts";
import { renderApprovals } from "../../cli/commands/workflow_approvals.ts";
import { renderApproveResult } from "../../cli/commands/workflow_approve.ts";
import {
  renderAwaitingParent,
  renderDetachedNestedRuns,
} from "../../cli/commands/nested_run_hints.ts";
import {
  renderPendingSignalResult,
  renderSignalResult,
} from "../../cli/commands/workflow_signal.ts";
import { renderWaits } from "../../cli/commands/workflow_waits.ts";
import { renderStepOutputsLog } from "../../cli/commands/workflow_history_outputs.ts";
import { hintTestContext } from "../../cli/commands/command_hint_test_helpers.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

await initializeLogging({});

const text = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\n", "\r", "["),
    fc.constantFrom("\x1b[31m", "\x1b[2J", "\x1b]0;title\x07"),
    fc.fullUnicode(),
  ),
});

const NUM_RUNS = 50;

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
} as unknown as ReturnType<typeof hintTestContext>["logger"];

// timers would outlive the test; a heartbeat never fires here
const STILL_CLOCK: RenderClock = { now: () => 0, every: () => () => {} };

function assertEscaped(
  output: string,
  printed: readonly string[],
  multiLine: readonly string[] = [],
): void {
  assertNoControlCharacters(output);
  for (const value of printed) {
    const escaped = escapeControlCharacters(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
  for (const value of multiLine) {
    const escaped = escapeControlCharactersInText(value);
    assert(
      output.includes(escaped),
      `${JSON.stringify(escaped)} missing from the output`,
    );
  }
}

type Handlers = Record<string, (event: unknown) => unknown>;

function feed(handlers: unknown, events: readonly object[]): void {
  for (const event of events) {
    const kind = (event as { kind: string }).kind;
    (handlers as Handlers)[kind](event);
  }
}

// a reply from another serve is cast, not validated, so events are built loosely
function events(...list: object[]): WorkflowRunEvent[] {
  return list as unknown as WorkflowRunEvent[];
}

function runView(fields: Record<string, unknown>): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "wf",
    status: "succeeded",
    jobs: [],
    ...fields,
  } as unknown as WorkflowRunView;
}

const runFields = fc.record({
  workflowName: text,
  stepId: text,
  runId: text,
  waitId: text,
  workflowOfNested: text,
  cancelCommand: text,
  line: text,
  vaultName: text,
  fieldPath: text,
  specName: text,
  schemaError: text,
  warning: text,
  envPath: text,
  envVar: text,
  requirement: text,
  target: text,
  assertMessage: text,
  reportName: text,
  reportError: text,
  deadline: text,
  reason: text,
  worker: text,
});

type RunFields = typeof runFields extends fc.Arbitrary<infer T> ? T : never;

function streamOf(f: RunFields): WorkflowRunEvent[] {
  return events(
    {
      kind: "superseded_runs",
      cancelledRunIds: [f.runId],
      skippedRuns: [{ runId: f.runId, waitIds: [f.waitId] }],
      cancelledNestedRuns: [{ runId: f.runId, workflowName: f.workflowName }],
      stopRequestedNestedRuns: [{
        runId: f.runId,
        workflowName: f.workflowName,
      }],
      detachedNestedRuns: [{
        runId: f.runId,
        workflowName: f.workflowName,
        cancelCommand: f.cancelCommand,
      }],
    },
    {
      kind: "started",
      runId: "run-1",
      workflowName: f.workflowName,
      jobs: [{ id: "job", stepCount: 2, dependsOn: [] }],
    },
    { kind: "job_started", jobId: "job" },
    {
      kind: "job_fanout_waiting",
      jobId: "job",
      worker: f.worker,
      queueTimeoutSeconds: 60,
    },
    { kind: "step_started", jobId: "job", stepId: f.stepId },
    {
      kind: "model_resolved",
      jobId: "job",
      stepId: f.stepId,
      modelName: "m",
      modelType: "t",
      modelId: "m-1",
      methodName: "run",
    },
    {
      kind: "method_output",
      jobId: "job",
      stepId: f.stepId,
      modelName: "m",
      methodName: "run",
      stream: "stdout",
      line: f.line,
    },
    {
      kind: "method_event",
      jobId: "job",
      stepId: f.stepId,
      modelName: "m",
      event: {
        type: "vault_secret_stored",
        vaultName: f.vaultName,
        fieldPath: f.fieldPath,
      },
    },
    {
      kind: "method_event",
      jobId: "job",
      stepId: f.stepId,
      modelName: "m",
      event: {
        type: "schema_validation_warning",
        specName: f.specName,
        error: f.schemaError,
      },
    },
    {
      kind: "method_event",
      jobId: "job",
      stepId: f.stepId,
      modelName: "m",
      event: { type: "stamped_tag_ignored", message: f.warning },
    },
    {
      kind: "env_var_warning",
      jobId: "job",
      stepId: f.stepId,
      envVars: [{ path: f.envPath, envVar: f.envVar }],
      message: f.warning,
    },
    {
      kind: "step_queued",
      jobId: "job",
      stepId: f.stepId,
      requirement: f.requirement,
    },
    {
      kind: "step_target_disconnected",
      jobId: "job",
      stepId: f.stepId,
      target: f.target,
    },
    { kind: "step_completed", jobId: "job", stepId: f.stepId },
    { kind: "step_started", jobId: "job", stepId: "check" },
    {
      kind: "assert_result",
      jobId: "job",
      stepId: "check",
      passed: false,
      message: f.assertMessage,
      severity: "high",
    },
    { kind: "report_failed", reportName: f.reportName, error: f.reportError },
    {
      kind: "signal_wait_requested",
      runId: "run-1",
      jobId: "job",
      stepId: f.stepId,
      waitId: f.waitId,
      deadline: f.deadline,
      workflowName: f.workflowOfNested,
    },
    {
      kind: "cancelled",
      reason: f.reason,
      run: runView({ status: "cancelled" }),
    },
  );
}

Deno.test("ConsoleWorkflowRunRenderer: no remote control character reaches the terminal, and every printed value is still there escaped", () => {
  fc.assert(
    fc.property(runFields, (f) => {
      const renderer = createWorkflowRunRenderer("log", {
        workflowName: "wf",
        clock: STILL_CLOCK,
      });
      const output = captureRaw(() => feed(renderer.handlers(), streamOf(f)));
      assertEscaped(
        output,
        [
          f.workflowName,
          f.stepId,
          f.runId,
          f.waitId,
          f.workflowOfNested,
          f.cancelCommand,
          f.vaultName,
          f.fieldPath,
          f.specName,
          f.envPath,
          f.envVar,
          f.requirement,
          f.target,
          f.reportName,
          f.deadline,
          f.reason,
          f.worker,
        ],
        [f.line, f.schemaError, f.warning, f.assertMessage, f.reportError],
      );
    }),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("ConsoleWorkflowRunRenderer: a quiet run replays a failed step's output and suspensions name nested runs and waits, all escaped", () => {
  fc.assert(
    fc.property(runFields, (f) => {
      const started = {
        kind: "started",
        runId: "run-1",
        workflowName: f.workflowName,
        jobs: [{ id: "job", stepCount: 1, dependsOn: [] }],
      };
      const quiet = createWorkflowRunRenderer("log", {
        workflowName: "wf",
        quiet: true,
        clock: STILL_CLOCK,
      });
      const replayed = captureRaw(() =>
        feed(
          quiet.handlers(),
          events(
            started,
            { kind: "step_started", jobId: "job", stepId: f.stepId },
            {
              kind: "method_output",
              jobId: "job",
              stepId: f.stepId,
              modelName: "m",
              methodName: "run",
              stream: "stdout",
              line: f.line,
            },
            { kind: "step_failed", jobId: "job", stepId: f.stepId },
            {
              kind: "completed",
              run: runView({
                id: f.runId,
                status: "failed",
                jobs: [{
                  name: "job",
                  status: "failed",
                  steps: [{ name: f.stepId, status: "failed", error: "boom" }],
                }],
              }),
            },
          ),
        )
      );
      assertEscaped(replayed, [f.stepId, f.workflowName], [f.line]);

      const nested = createWorkflowRunRenderer("log", {
        workflowName: "wf",
        clock: STILL_CLOCK,
      });
      const suspendedOnNested = captureRaw(() =>
        feed(
          nested.handlers(),
          events(started, {
            kind: "suspended",
            jobId: "job",
            stepId: f.stepId,
            prompt: "",
            run: runView({ id: f.runId, status: "suspended" }),
            nested: { workflowName: f.workflowOfNested, runId: f.runId },
          }),
        )
      );
      assertEscaped(suspendedOnNested, [
        f.workflowName,
        f.stepId,
        f.workflowOfNested,
        f.runId,
      ]);

      const waiting = createWorkflowRunRenderer("log", {
        workflowName: "wf",
        clock: STILL_CLOCK,
      });
      const suspendedOnWait = captureRaw(() =>
        feed(
          waiting.handlers(),
          events(started, {
            kind: "suspended",
            jobId: "job",
            stepId: f.stepId,
            prompt: "",
            run: runView({ id: f.runId, status: "suspended" }),
            wait: { id: f.waitId, deadline: f.deadline },
          }),
        )
      );
      assertEscaped(suspendedOnWait, [f.workflowName, f.stepId, f.waitId]);
    }),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("renderWorkflowRunDisplay: no remote control character reaches the terminal, and JSON mode keeps the values", () => {
  fc.assert(
    fc.property(
      fc.record({
        workflowName: text,
        id: text,
        job: text,
        step: text,
        nestedRun: text,
        nestedWorkflow: text,
        waitId: text,
        receiptId: text,
        receivedAt: text,
        deadline: text,
        guard: text,
        refused: text,
        path: text,
        gateKind: text,
      }),
      (f) => {
        const view = runView({
          workflowName: f.workflowName,
          id: f.id,
          status: "interrupted",
          path: f.path,
          autoContinuation: { refused: { reason: f.refused, message: "m" } },
          jobs: [{
            name: f.job,
            status: "failed",
            steps: [
              {
                name: f.step,
                status: "waiting_approval",
                nestedRun: {
                  runId: f.nestedRun,
                  workflowName: f.nestedWorkflow,
                },
              },
              {
                name: f.step,
                status: "waiting",
                wait: {
                  id: f.waitId,
                  deadline: f.deadline,
                  receipt: {
                    id: f.receiptId,
                    receivedAt: f.receivedAt,
                    submittedBy: "u",
                  },
                },
              },
              {
                name: f.step,
                status: "waiting",
                wait: { id: f.waitId, deadline: f.deadline },
              },
              {
                name: f.step,
                status: "skipped",
                skipReason: { kind: "guarded", expression: f.guard },
              },
            ],
            fanOut: {
              selector: {},
              plannedLanes: 0,
              budget: { used: 0, allowed: null },
              batches: [],
              members: [],
              gates: [{ kind: f.gateKind, status: "held" }],
              halts: [],
            },
          }],
        });
        assertEscaped(
          captureRaw(() => renderWorkflowRunDisplay(view, "log")),
          [
            f.workflowName,
            f.id,
            f.job,
            f.step,
            f.nestedRun,
            f.nestedWorkflow,
            f.waitId,
            f.receiptId,
            f.receivedAt,
            f.deadline,
            f.guard,
            f.refused,
            f.path,
            f.gateKind,
          ],
        );
        const json = JSON.parse(
          captureRaw(() => renderWorkflowRunDisplay(view, "json")),
        );
        assertEquals(json.workflowName, f.workflowName);
        assertEquals(json.jobs[0].steps[0].name, f.step);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("workflow create, doctor, validate and history logs renderers: no remote control character reaches the terminal", () => {
  fc.assert(
    fc.property(
      fc.record({
        name: text,
        path: text,
        job: text,
        jobDescription: text,
        step: text,
        taskType: text,
        stepDescription: text,
        file: text,
        warning: text,
        error: text,
        logLine: text,
        runId: text,
      }),
      (f) => {
        const create = createWorkflowCreateRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            feed(create, [{
              kind: "completed",
              data: {
                name: f.name,
                path: f.path,
                jobs: [{
                  name: f.job,
                  description: f.jobDescription,
                  steps: [{
                    name: f.step,
                    taskType: f.taskType,
                    description: f.stepDescription,
                  }],
                }],
              },
            }])
          ),
          [
            f.name,
            f.path,
            f.job,
            f.jobDescription,
            f.step,
            f.taskType,
            f.stepDescription,
          ],
        );

        const doctor = createWorkflowDoctorRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            feed(doctor, [
              {
                kind: "workflow-checked",
                result: {
                  file: f.file,
                  name: null,
                  status: "warn",
                  warning: f.warning,
                },
              },
              {
                kind: "workflow-checked",
                result: {
                  file: f.file,
                  name: f.name,
                  status: "fail",
                  error: f.error,
                },
              },
            ])
          ),
          [f.file, f.name],
          [f.warning, f.error],
        );

        const validate = createWorkflowValidateRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            feed(validate, [{
              kind: "completed",
              data: {
                workflowName: f.name,
                passed: false,
                totalWarnings: 0,
                validations: [{ name: f.step, passed: false, error: f.error }],
              },
            }])
          ),
          [f.name, f.step],
          [f.error],
        );

        const logs = createWorkflowHistoryLogsRenderer("log").handlers();
        assertEscaped(
          captureRaw(() =>
            feed(logs, [
              {
                kind: "completed",
                data: {
                  type: "log",
                  log: { path: f.path, lines: [f.logLine] },
                },
              },
              {
                kind: "completed",
                data: {
                  type: "empty_log",
                  info: { runId: f.runId, workflowName: f.name, path: f.path },
                },
              },
              {
                kind: "completed",
                data: {
                  type: "no_log_file",
                  info: { runId: f.runId, workflowName: f.name },
                },
              },
            ])
          ),
          [f.path, f.runId.slice(0, 8)],
          [f.logLine],
        );
        const json = JSON.parse(
          captureRaw(() =>
            feed(createWorkflowHistoryLogsRenderer("json").handlers(), [{
              kind: "completed",
              data: { type: "log", log: { path: f.path, lines: [f.logLine] } },
            }])
          ),
        );
        assertEquals(json.lines, [f.logLine]);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

// brackets close a mermaid node label, so the graph is driven with names that hold none
const graphName = fc.string({
  unit: fc.oneof(
    fc.constantFrom("\x00", "\x07", "\x1b", "\x7f", "\x9b", "\r"),
    fc.constantFrom("a", "b", "z", "1", "-"),
  ),
  minLength: 1,
  maxLength: 12,
});

Deno.test("renderWorkflowGraph: no control character in a workflow, job or step name reaches the terminal", () => {
  fc.assert(
    fc.property(graphName, graphName, graphName, (name, job, step) => {
      const output = renderWorkflowGraph(
        {
          name,
          jobs: [
            { name: `${job}1`, dependsOn: [], steps: [] },
            {
              name: `${job}2`,
              dependsOn: [{ job: `${job}1` }],
              steps: [
                { name: `${step}1`, dependsOn: [], task: { type: step } },
                {
                  name: `${step}2`,
                  dependsOn: [{ step: `${step}1` }],
                  task: { type: "model_method" },
                },
              ],
            },
          ],
        } as unknown as Parameters<typeof renderWorkflowGraph>[0],
      );
      assertEscaped(output, [name, `${job}2`, `${step}1`, step]);
    }),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("inputPairs: no control character in an input key or value survives", () => {
  fc.assert(
    fc.property(text, text, text, (key, value, omitted) => {
      const pairs = inputPairs({
        inputs: { [key]: value },
        inputsOmitted: [omitted],
      }).join("\n");
      assertEscaped(pairs, [key, value, omitted]);
    }),
    { numRuns: NUM_RUNS },
  );
});

Deno.test("workflow approvals, approve, nested run hints, signal, waits and outputs: no server-supplied control character reaches the terminal", () => {
  fc.assert(
    fc.property(
      fc.record({
        workflowName: text,
        runId: text,
        parentRunId: text,
        command: text,
        receivedAt: text,
        receiptId: text,
        settledAt: text,
        stepName: text,
        outputKey: text,
        outputValue: text,
      }),
      (f) => {
        // logger lines are escaped by the formatter; only writeOutput lines are checked
        const ctx = hintTestContext({ logger: SILENT_LOGGER });
        assertEscaped(
          captureRaw(() =>
            renderApprovals(ctx, [{
              workflowId: "wf-id",
              workflowName: "wf",
              runId: f.runId,
              stepName: "gate",
              suspendedAt: "2026-10-02T18:18:40.459Z",
              prompt: "ok?",
              inputs: {},
              parentRun: {
                workflowName: f.workflowName,
                runId: f.parentRunId,
              },
            } as unknown as PendingApproval], [{
              workflowId: "wf-id",
              workflowName: "wf",
              runId: f.runId,
              stepName: "gate",
              suspendedAt: "2026-10-02T18:18:40.459Z",
              timeoutSeconds: 1,
              expiredAt: "2026-10-02T19:18:40.459Z",
              serveStarted: true,
            }])
          ),
          [f.workflowName],
        );

        const parent: AwaitingParentData = {
          workflowId: "p",
          workflowName: f.workflowName,
          runId: f.parentRunId,
          resumeCommand: f.command,
        };
        const detached: DetachedNestedRunData = {
          workflowId: "c",
          workflowName: f.workflowName,
          runId: f.runId,
          jobName: "j",
          stepName: "s",
          cancelCommand: f.command,
        };
        assertEscaped(
          captureRaw(() => {
            renderAwaitingParent(ctx, parent);
            renderDetachedNestedRuns(ctx, [detached]);
          }),
          [f.workflowName, f.parentRunId, f.runId, f.command],
        );

        assertEscaped(
          captureRaw(() =>
            renderApproveResult(
              ctx,
              {
                workflowName: f.workflowName,
                stepName: "gate",
                runId: f.runId,
                allGatesDecided: true,
                awaitingParent: parent,
              } as unknown as WorkflowApproveData,
            )
          ),
          [f.command],
        );

        const signalled = {
          waitId: "w",
          workflowId: "wf-id",
          workflowName: f.workflowName,
          runId: f.runId,
          jobName: "j",
          stepName: f.stepName,
          signal: { id: f.receiptId, receivedAt: f.receivedAt },
          awaitingResume: true,
          runRecordAvailable: true,
          resumeCommand: f.command,
          duplicate: true,
        } as unknown as WorkflowSignalData;
        assertEscaped(
          captureRaw(() => renderSignalResult(ctx, signalled)),
          [f.receivedAt, f.command],
        );
        assertEscaped(
          captureRaw(() =>
            renderSignalResult(ctx, { ...signalled, duplicate: undefined })
          ),
          [f.command],
        );
        const json = JSON.parse(
          captureRaw(() =>
            renderSignalResult(
              hintTestContext({ outputMode: "json", logger: SILENT_LOGGER }),
              signalled,
            )
          ),
        );
        assertEquals(json.resumeCommand, f.command);

        assertEscaped(
          captureRaw(() =>
            renderPendingSignalResult(
              ctx,
              {
                signal: { id: "s", receivedAt: f.receivedAt },
                heldUntil: "later",
                lastWait: {
                  settledAs: "accepted",
                  receipt: { id: f.receiptId },
                  settledAt: f.settledAt,
                },
              } as unknown as Parameters<typeof renderPendingSignalResult>[1],
            )
          ),
          [f.receiptId, f.settledAt],
        );

        assertEscaped(
          captureRaw(() =>
            renderWaits(ctx, {
              waits: [{
                nextCommand: f.command,
                signalByKeyCommand: f.command,
                workflowName: f.workflowName,
                stepName: f.stepName,
                waitId: "w",
                runId: f.runId,
                deadline: "d",
                schema: {},
              }],
              unreadableWaits: [{
                workflowId: "wf-id",
                workflowName: f.workflowName,
                runId: f.runId,
                jobName: "j",
                stepName: f.stepName,
                nextCommand: f.command,
              }],
            } as unknown as WorkflowWaitsData)
          ),
          [f.command],
        );

        assertEscaped(
          captureRaw(() =>
            renderStepOutputsLog({
              [f.stepName]: { [f.outputKey]: f.outputValue },
            })
          ),
          [f.stepName, f.outputKey],
          [JSON.stringify(f.outputValue)],
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});
