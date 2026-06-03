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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { EventBridge, WorkflowRunTree } from "./workflow_run_tree.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

function createTestBridge(): EventBridge {
  return new EventBridge();
}

/** Wait for React to process state updates after dispatching events. */
function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test({
  name: "WorkflowRunTree renders waiting jobs after started event",
  ...inkTestOptions,
  fn: async () => {
    const bridge = createTestBridge();
    const { lastFrame } = render(
      <WorkflowRunTree
        bridge={bridge}
        workflowName="deploy"
        onDone={() => {}}
      />,
    );

    bridge.push({
      kind: "started",
      runId: "run-1",
      workflowName: "deploy",
      jobs: [
        { id: "provision", stepCount: 1, dependsOn: [] },
        { id: "configure", stepCount: 2, dependsOn: ["provision"] },
      ],
    });

    await tick();
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "provision");
    assertStringIncludes(output, "configure");
  },
});

Deno.test({
  name: "WorkflowRunTree shows running job with step info",
  ...inkTestOptions,
  fn: async () => {
    const bridge = createTestBridge();
    const { lastFrame } = render(
      <WorkflowRunTree
        bridge={bridge}
        workflowName="deploy"
        onDone={() => {}}
      />,
    );

    bridge.push({
      kind: "started",
      runId: "run-1",
      workflowName: "deploy",
      jobs: [{ id: "provision", stepCount: 1, dependsOn: [] }],
    });
    bridge.push({ kind: "job_started", jobId: "provision" });
    bridge.push({
      kind: "step_started",
      jobId: "provision",
      stepId: "s1",
    });
    bridge.push({
      kind: "model_resolved",
      jobId: "provision",
      stepId: "s1",
      modelName: "ec2-instance",
      modelType: "aws/ec2",
      modelId: "test-model-id",
      methodName: "create",
    });

    await tick();
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "provision");
    assertStringIncludes(output, "ec2-instance");
  },
});

Deno.test({
  name: "WorkflowRunTree shows blocked jobs",
  ...inkTestOptions,
  fn: async () => {
    const bridge = createTestBridge();
    const { lastFrame } = render(
      <WorkflowRunTree
        bridge={bridge}
        workflowName="deploy"
        onDone={() => {}}
      />,
    );

    bridge.push({
      kind: "started",
      runId: "run-1",
      workflowName: "deploy",
      jobs: [
        { id: "build", stepCount: 1, dependsOn: [] },
        { id: "deploy", stepCount: 1, dependsOn: ["build"] },
      ],
    });

    await tick();
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "deploy");
    assertStringIncludes(output, "blocked");
  },
});

Deno.test({
  name: "WorkflowRunTree buffers events before mount",
  ...inkTestOptions,
  fn: async () => {
    const bridge = createTestBridge();

    // Push events before rendering
    bridge.push({
      kind: "started",
      runId: "run-1",
      workflowName: "ci",
      jobs: [{ id: "test", stepCount: 1, dependsOn: [] }],
    });
    bridge.push({ kind: "job_started", jobId: "test" });

    const { lastFrame } = render(
      <WorkflowRunTree
        bridge={bridge}
        workflowName="ci"
        onDone={() => {}}
      />,
    );

    await tick();
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "test");
  },
});
