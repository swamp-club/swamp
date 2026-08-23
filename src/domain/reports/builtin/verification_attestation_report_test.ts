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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { verificationAttestationReport } from "./verification_attestation_report.ts";
import type { WorkflowReportContext } from "../report_context.ts";
import { createDataId } from "../../data/data_id.ts";

function makeStepExecution(
  overrides: Partial<WorkflowReportContext["stepExecutions"][0]> = {},
): WorkflowReportContext["stepExecutions"][0] {
  return {
    jobName: "static-analysis",
    stepName: "lint",
    taskType: "model_method",
    modelName: "lint",
    modelType: "@swamp/deno-runner",
    methodName: "task",
    status: "succeeded",
    dataHandles: [],
    methodArgs: {},
    modelId: "def-1",
    globalArgs: {},
    ...overrides,
  };
}

function makeWorkflowContext(
  overrides: Partial<WorkflowReportContext> = {},
): WorkflowReportContext {
  return {
    scope: "workflow",
    repoDir: "/tmp/test-repo",
    // deno-lint-ignore no-explicit-any
    logger: {} as any,
    // deno-lint-ignore no-explicit-any
    dataRepository: {} as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    workflowId: "wf-1",
    workflowRunId: "run-1",
    workflowName: "verify-changes",
    workflowStatus: "succeeded",
    inputs: { commit: "abc123", branch: "fix/vault" },
    stepExecutions: [],
    ...overrides,
  };
}

Deno.test("verificationAttestationReport: all steps pass — markdown shows checkmarks and gate passed", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({ jobName: "static-analysis", stepName: "lint" }),
      makeStepExecution({ jobName: "static-analysis", stepName: "fmt-check" }),
      makeStepExecution({ jobName: "tests", stepName: "run-tests" }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "# Verification Attestation");
  assertStringIncludes(result.markdown, "`abc123`");
  assertStringIncludes(result.markdown, "`fix/vault`");
  assertStringIncludes(result.markdown, "3 passed · 0 failed · 0 skipped");
  assertStringIncludes(result.markdown, "✓ **static-analysis**");
  assertStringIncludes(result.markdown, "✓ **tests**");
  assertStringIncludes(result.markdown, "**Gate:** 3/3 passed, 0 skipped");
});

Deno.test("verificationAttestationReport: failed step shows cross and retrieval commands", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({ jobName: "static-analysis", stepName: "lint" }),
      makeStepExecution({
        jobName: "tests",
        stepName: "run-tests",
        modelName: "tests",
        status: "failed",
        dataHandles: [
          {
            name: "result",
            specName: "result",
            kind: "resource",
            dataId: createDataId("d-1"),
            version: 1,
            size: 100,
            tags: {},
            // deno-lint-ignore no-explicit-any
            metadata: {} as any,
          },
        ],
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "1 passed · 1 failed · 0 skipped");
  assertStringIncludes(result.markdown, "✓ **static-analysis**");
  assertStringIncludes(result.markdown, "✗ **tests**");
  assertStringIncludes(result.markdown, "✗ run-tests");
  assertStringIncludes(
    result.markdown,
    "→ `swamp data get tests result`",
  );
});

Deno.test("verificationAttestationReport: skipped step shows circle icon", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({ jobName: "static-analysis", stepName: "lint" }),
      makeStepExecution({
        jobName: "ux-review",
        stepName: "review",
        modelType: "@swamp/agent-runner",
        status: "skipped",
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "1 passed · 0 failed · 1 skipped");
  assertStringIncludes(result.markdown, "○ review");
  assertStringIncludes(result.markdown, "**Gate:** 1/2 passed, 1 skipped");
});

Deno.test("verificationAttestationReport: inputs default to unknown when missing", async () => {
  const ctx = makeWorkflowContext({
    inputs: undefined,
    stepExecutions: [],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "`unknown`");
  const json = result.json as Record<string, Record<string, string>>;
  assertEquals(json.subject.commit, "unknown");
  assertEquals(json.subject.branch, "unknown");
});

Deno.test("verificationAttestationReport: JSON structure matches attestation schema", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({ status: "succeeded" }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);
  const json = result.json;

  assertEquals(json.version, "1");
  assertEquals(json.type, "verification-attestation");
  assertEquals(json.workflowRunId, "run-1");
  assertEquals(json.workflowId, "wf-1");
  assertEquals(json.workflowName, "verify-changes");

  const subject = json.subject as Record<string, string>;
  assertEquals(subject.commit, "abc123");
  assertEquals(subject.branch, "fix/vault");

  const gate = json.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, true);
  assertEquals(gate.stepsCompleted, 1);
  assertEquals(gate.stepsTotal, 1);
  assertEquals(gate.stepsSkipped, 0);
  assertEquals(gate.stepsFailed, 0);

  assertEquals(json.failures, undefined);
});

Deno.test("verificationAttestationReport: JSON includes failures array when steps fail", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({
        jobName: "compile",
        stepName: "binary-check",
        modelName: "binary-check",
        modelType: "command/shell",
        status: "failed",
        dataHandles: [
          {
            name: "result",
            specName: "result",
            kind: "resource",
            dataId: createDataId("d-1"),
            version: 1,
            size: 50,
            tags: {},
            // deno-lint-ignore no-explicit-any
            metadata: {} as any,
          },
        ],
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);
  const json = result.json;

  const gate = json.gate as Record<string, unknown>;
  assertEquals(gate.allPassed, false);
  assertEquals(gate.stepsFailed, 1);

  const failures = json.failures as Array<Record<string, unknown>>;
  assertEquals(failures.length, 1);
  assertEquals(failures[0].job, "compile");
  assertEquals(failures[0].step, "binary-check");
  assertEquals(failures[0].retrievalCommands, [
    "swamp data get binary-check result",
  ]);

  const steps = json.steps as Array<Record<string, unknown>>;
  assertEquals(steps[0].retrievalCommands, [
    "swamp data get binary-check result",
  ]);
});

Deno.test("verificationAttestationReport: multi-job grouping with mixed statuses", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({
        jobName: "static-analysis",
        stepName: "lint",
        status: "succeeded",
      }),
      makeStepExecution({
        jobName: "static-analysis",
        stepName: "fmt-check",
        status: "succeeded",
      }),
      makeStepExecution({
        jobName: "tests",
        stepName: "run-tests",
        status: "succeeded",
      }),
      makeStepExecution({
        jobName: "compile",
        stepName: "build",
        status: "succeeded",
      }),
      makeStepExecution({
        jobName: "code-review",
        stepName: "review",
        modelType: "@swamp/agent-runner",
        status: "failed",
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "4 passed · 1 failed · 0 skipped");
  assertStringIncludes(result.markdown, "✓ **static-analysis**");
  assertStringIncludes(result.markdown, "✓ **tests**");
  assertStringIncludes(result.markdown, "✓ **compile**");
  assertStringIncludes(result.markdown, "✗ **code-review**");
  assertStringIncludes(result.markdown, "**Gate:** 4/5 passed, 0 skipped");
});

Deno.test("verificationAttestationReport: failed step without data handles omits retrieval commands", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({
        status: "failed",
        dataHandles: [],
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assert(!result.markdown.includes("→"));
  assertEquals(result.json.failures, undefined);

  const steps = result.json.steps as Array<Record<string, unknown>>;
  assertEquals(steps[0].retrievalCommands, []);
});

Deno.test("verificationAttestationReport: job with all skipped steps shows checkmark", async () => {
  const ctx = makeWorkflowContext({
    stepExecutions: [
      makeStepExecution({
        jobName: "ux-review",
        stepName: "review",
        status: "skipped",
      }),
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "✓ **ux-review**");
  assertStringIncludes(result.markdown, "○ review");
});

Deno.test("verificationAttestationReport: failed assert step appears in attestation", async () => {
  const ctx = makeWorkflowContext({
    workflowStatus: "failed",
    stepExecutions: [
      makeStepExecution({
        jobName: "validate",
        stepName: "run-model",
        status: "succeeded",
      }),
      {
        jobName: "validate",
        stepName: "check-output",
        taskType: "assert",
        modelName: "",
        modelType: "",
        methodName: "",
        status: "failed",
        dataHandles: [],
        methodArgs: {},
        modelId: "",
        globalArgs: {},
        errorMessage: "Expected output to contain result.",
      },
    ],
  });

  const result = await verificationAttestationReport.execute(ctx);

  assertStringIncludes(result.markdown, "1 passed · 1 failed · 0 skipped");
  assertStringIncludes(result.markdown, "✗ **validate**");
  assertStringIncludes(
    result.markdown,
    "✗ check-output  —  assert  (failed)",
  );
  assertStringIncludes(
    result.markdown,
    "Expected output to contain result.",
  );
  assertStringIncludes(result.markdown, "**Gate:** 1/2 passed, 0 skipped");

  const json = result.json;
  const steps = json.steps as Array<Record<string, unknown>>;
  assertEquals(steps.length, 2);
  assertEquals(steps[1].taskType, "assert");
  assertEquals(steps[1].status, "failed");
  assertEquals(steps[1].errorMessage, "Expected output to contain result.");

  const failures = json.failures as Array<Record<string, unknown>>;
  assertEquals(failures!.length, 1);
  assertEquals(failures![0].taskType, "assert");
  assertEquals(
    failures![0].errorMessage,
    "Expected output to contain result.",
  );
});
