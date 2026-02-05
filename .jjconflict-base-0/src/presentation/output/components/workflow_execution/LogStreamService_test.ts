import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { LogStreamService, type LogStreamTarget } from "./LogStreamService.ts";
import type { WorkflowRunData } from "../../../../domain/workflows/workflow_run.ts";

// Test utilities
async function createTempDir(): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "logstream_test_" });
  return tempDir;
}

async function createWorkflowRunFile(
  repoDir: string,
  workflowId: string,
  runId: string,
  runData: WorkflowRunData,
): Promise<void> {
  const runDir = join(repoDir, ".swamp", "workflow-runs", workflowId);
  await Deno.mkdir(runDir, { recursive: true });

  const fileName = `workflow-run-${runId}.yaml`;
  const filePath = join(runDir, fileName);
  const yamlContent = stringifyYaml(runData);

  await Deno.writeTextFile(filePath, yamlContent);
}

async function cleanup(tempDir: string): Promise<void> {
  try {
    await Deno.remove(tempDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("LogStreamService - hasLogs returns false for non-existent logs", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: "test-run-id",
    };

    const hasLogs = await service.hasLogs(target);
    assertEquals(hasLogs, false);
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs for pending step", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "running",
      jobs: [{
        jobName: "test-job",
        status: "running",
        steps: [{
          stepName: "test-step",
          status: "pending",
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "pending",
    };

    const logs = await service.getLogs(target);
    assertEquals(logs.length, 2);
    assertStringIncludes(logs[0].message, "has not started yet");
    assertStringIncludes(logs[1].message, "Waiting for dependencies");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs for completed step with output", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "succeeded",
      jobs: [{
        jobName: "test-job",
        status: "succeeded",
        steps: [{
          stepName: "test-step",
          status: "succeeded",
          startedAt: "2024-01-01T10:00:00Z",
          completedAt: "2024-01-01T10:00:05Z",
          output: {
            stdout: "Hello, World!\nStep executed successfully",
            exitCode: 0,
          },
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "succeeded",
    };

    const logs = await service.getLogs(target);

    // Should have: streaming message, started at, stdout lines, completed at
    assertEquals(logs.length >= 4, true);
    assertStringIncludes(logs[0].message, "Streaming logs for step");
    assertStringIncludes(logs[1].message, "Step started at");
    assertStringIncludes(logs[2].message, "Hello, World!");
    assertStringIncludes(logs[3].message, "Step executed successfully");
    assertStringIncludes(logs[logs.length - 1].message, "Step completed at");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs for step with stderr", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "failed",
      jobs: [{
        jobName: "test-job",
        status: "failed",
        steps: [{
          stepName: "test-step",
          status: "failed",
          startedAt: "2024-01-01T10:00:00Z",
          completedAt: "2024-01-01T10:00:05Z",
          output: {
            stdout: "Some output",
            stderr: "Error occurred\nFailed to execute",
            exitCode: 1,
          },
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "failed",
    };

    const logs = await service.getLogs(target);

    // Find stderr entries
    const stderrLogs = logs.filter((log) => log.message.includes("[STDERR]"));
    assertEquals(stderrLogs.length, 2);
    assertStringIncludes(stderrLogs[0].message, "[STDERR] Error occurred");
    assertStringIncludes(stderrLogs[1].message, "[STDERR] Failed to execute");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs for skipped step", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "succeeded",
      jobs: [{
        jobName: "test-job",
        status: "succeeded",
        steps: [{
          stepName: "test-step",
          status: "skipped",
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "skipped",
    };

    const logs = await service.getLogs(target);
    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0].message, "was skipped");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs handles missing workflow run file", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    // Create the base workflow-runs directory but no actual run files
    const runDir = join(tempDir, ".swamp", "workflow-runs");
    await Deno.mkdir(runDir, { recursive: true });

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: "non-existent-run",
      stepStatus: "running", // Use running so it tries to find the file
    };

    const logs = await service.getLogs(target);
    assertEquals(logs.length >= 1, true);
    assertStringIncludes(logs[0].message, "No workflow run data found");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs handles missing job", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "running",
      jobs: [{
        jobName: "different-job",
        status: "running",
        steps: [],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "missing-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "running", // Use running so it tries to find the job
    };

    const logs = await service.getLogs(target);
    assertEquals(logs.length >= 1, true);
    assertStringIncludes(logs[0].message, "Job missing-job not found");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getLogs handles missing step", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "running",
      jobs: [{
        jobName: "test-job",
        status: "running",
        steps: [{
          stepName: "different-step",
          status: "running",
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "missing-step",
      workflowRunId: runId,
      stepStatus: "running", // Use running so it tries to find the step
    };

    const logs = await service.getLogs(target);
    assertEquals(logs.length >= 1, true);
    assertStringIncludes(logs[0].message, "Step missing-step not found");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - streamLogs for completed step", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "succeeded",
      jobs: [{
        jobName: "test-job",
        status: "succeeded",
        steps: [{
          stepName: "test-step",
          status: "succeeded",
          startedAt: "2024-01-01T10:00:00Z",
          completedAt: "2024-01-01T10:00:05Z",
          output: {
            stdout: "Line 1\nLine 2\nLine 3",
            exitCode: 0,
          },
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    const target: LogStreamTarget = {
      type: "step",
      jobName: "test-job",
      stepName: "test-step",
      workflowRunId: runId,
      stepStatus: "succeeded",
    };

    const logs = [];
    for await (const log of service.streamLogs(target)) {
      logs.push(log);
    }

    // Should have all logs from the completed step
    assertEquals(logs.length >= 5, true); // streaming, started, 3 stdout lines, completed
    assertStringIncludes(logs[0].message, "Streaming logs for step");
    assertStringIncludes(logs[2].message, "Line 1");
    assertStringIncludes(logs[3].message, "Line 2");
    assertStringIncludes(logs[4].message, "Line 3");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getCurrentStepInfo", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    const workflowId = "workflow-123";
    const runId = "run-456";

    const runData: WorkflowRunData = {
      id: runId,
      workflowId: workflowId,
      workflowName: "test-workflow",
      status: "running",
      jobs: [{
        jobName: "test-job",
        status: "running",
        steps: [{
          stepName: "test-step",
          status: "running",
        }],
      }],
    };

    await createWorkflowRunFile(tempDir, workflowId, runId, runData);

    // Use reflection to access private method for testing
    const stepInfo = await (service as unknown as {
      getCurrentStepInfo: (
        jobName: string,
        stepName: string,
        runId: string,
      ) => Promise<{ status: string } | null>;
    }).getCurrentStepInfo("test-job", "test-step", runId);

    assertEquals(stepInfo?.status, "running");
  } finally {
    await cleanup(tempDir);
  }
});

Deno.test("LogStreamService - getCurrentStepInfo returns null for missing data", async () => {
  const tempDir = await createTempDir();
  const service = new LogStreamService(tempDir);

  try {
    // Use reflection to access private method for testing
    const stepInfo = await (service as unknown as {
      getCurrentStepInfo: (
        jobName: string,
        stepName: string,
        runId: string,
      ) => Promise<{ status: string } | null>;
    }).getCurrentStepInfo("missing-job", "missing-step", "missing-run");

    assertEquals(stepInfo, null);
  } finally {
    await cleanup(tempDir);
  }
});
