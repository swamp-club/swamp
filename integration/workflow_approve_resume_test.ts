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

import { join } from "@std/path";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import {
  type StepExecutor,
  WorkflowExecutionService,
} from "../src/domain/workflows/execution_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { TriggerCondition } from "../src/domain/workflows/trigger_condition.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { workflowApproveCommand } from "../src/cli/commands/workflow_approve.ts";

import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const noSteps: StepExecutor = {
  execute: () => Promise.reject(new Error("a gate-only workflow runs no step")),
};

async function withRepo(fn: (repoDir: string) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-approve-resume-" });
  try {
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await fn(repoDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function gatedWorkflow(gates: string[]): Workflow {
  return Workflow.create({
    name: "gated",
    jobs: [
      Job.create({
        name: "main",
        steps: gates.map((name) =>
          Step.create({
            name,
            task: StepTask.manualApproval(`approve ${name}`),
          })
        ),
      }),
    ],
  });
}

async function suspendRun(
  repoDir: string,
  workflow: Workflow,
): Promise<WorkflowRun> {
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  await workflowRepo.save(workflow);
  const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
  const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    const service = new WorkflowExecutionService(
      workflowRepo,
      new YamlWorkflowRunRepository(repoDir),
      repoDir,
      noSteps,
      undefined,
      catalogStore,
      undefined,
      undefined,
      undefined,
      undefined,
      tracker,
    );
    const run = await service.execute(workflow.name, {});
    assertEquals(run.status, "suspended");
    return run;
  } finally {
    tracker.close();
    catalogStore.close();
  }
}

async function reloadRun(
  repoDir: string,
  workflow: Workflow,
  runId: string,
): Promise<WorkflowRun | null> {
  return await new YamlWorkflowRunRepository(repoDir).findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(runId),
  );
}

async function runApprove(
  args: string[],
  lines: string[] = [],
): Promise<{ lines: string[]; exitCode: number }> {
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command("approve", workflowApproveCommand);
  const originalLog = console.log;
  console.log = (...parts: unknown[]) =>
    lines.push(parts.map(String).join(" "));
  const previousExitCode = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    await root.parse(["approve", ...args]);
    return { lines, exitCode: Deno.exitCode };
  } finally {
    console.log = originalLog;
    Deno.exitCode = previousExitCode;
  }
}

Deno.test({
  name:
    "workflow approve --resume: approving the last gate resumes the run to success in one invocation",
  // The resume leaves its run tracker and catalog store to process exit.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow(["gate"]);
      const run = await suspendRun(repoDir, workflow);

      const { lines, exitCode } = await runApprove([
        "gated",
        "gate",
        "--run",
        run.id,
        "--resume",
        "--json",
        "--repo-dir",
        repoDir,
      ]);

      assertEquals(exitCode, 0);
      assertEquals(
        (await reloadRun(repoDir, workflow, run.id))?.status,
        "succeeded",
      );
      const approval = JSON.parse(lines[0]);
      assertEquals(approval.approved, true);
      assertEquals(approval.allGatesDecided, true);
      assertEquals(approval.resuming, true);
      const resumed = lines.slice(1).map((line) => JSON.parse(line));
      assertEquals(resumed.length > 0, true);
      assertEquals(resumed.at(-1).status, "succeeded");
    });
  },
});

Deno.test({
  name:
    "workflow approve --resume: a sibling gate still waiting leaves the run suspended and names the gate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow(["gate-a", "gate-b"]);
      const run = await suspendRun(repoDir, workflow);

      const { lines, exitCode } = await runApprove([
        "gated",
        "gate-a",
        "--run",
        run.id,
        "--resume",
        "--json",
        "--repo-dir",
        repoDir,
      ]);

      assertEquals(exitCode, 0);
      assertEquals(lines.length, 1);
      const approval = JSON.parse(lines[0]);
      assertEquals(approval.resuming, false);
      assertEquals(approval.allGatesDecided, false);
      assertEquals(approval.pendingGates.approvals, [
        { jobName: "main", stepName: "gate-b" },
      ]);
      const reloaded = await reloadRun(repoDir, workflow, run.id);
      assertEquals(reloaded?.status, "suspended");
      assertEquals(reloaded?.findWaitingApprovalSteps(), [
        { jobName: "main", stepName: "gate-b" },
      ]);
    });
  },
});

Deno.test({
  name:
    "workflow approve --resume: a resume the run refuses fails the command and keeps the approval",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const workflow = gatedWorkflow(["gate"]);
      const run = await suspendRun(repoDir, workflow);
      // a step added after the gate while the run waited is drift the resume
      // refuses to walk into; approve does not check structure
      await new YamlWorkflowRepository(repoDir).save(
        Workflow.create({
          id: workflow.id,
          name: workflow.name,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "gate",
                  task: StepTask.manualApproval("approve gate"),
                }),
                Step.create({
                  name: "deploy",
                  task: StepTask.model("missing-model", "run"),
                  dependsOn: [{
                    step: "gate",
                    condition: TriggerCondition.succeeded(),
                  }],
                }),
              ],
            }),
          ],
        }),
      );

      const lines: string[] = [];
      const error = await assertRejects(
        () =>
          runApprove([
            "gated",
            "gate",
            "--run",
            run.id,
            "--resume",
            "--json",
            "--repo-dir",
            repoDir,
          ], lines),
        Error,
      );
      assertStringIncludes(error.message, "deploy");
      assertEquals(lines.length, 1);
      assertEquals(JSON.parse(lines[0]).resuming, true);

      const reloaded = await reloadRun(repoDir, workflow, run.id);
      assertEquals(reloaded?.status, "suspended");
      assertEquals(reloaded?.findWaitingApprovalSteps(), []);
      assertEquals(reloaded?.isAwaitingResume(), true);
    });
  },
});

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";

interface FakeServe {
  url: string;
  requests: { type: string; payload: Record<string, unknown> }[];
  shutdown: () => Promise<void>;
}

function fakeServe(
  approveReply: Record<string, unknown>,
  resume: { status: string } | { suspend: true } | { refuse: string },
): FakeServe {
  const requests: FakeServe["requests"] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (message) => {
        const request = JSON.parse(message.data as string) as {
          type: string;
          id: string;
          payload: Record<string, unknown>;
        };
        requests.push({ type: request.type, payload: request.payload });
        if (request.type === "workflow.approve") {
          socket.send(JSON.stringify({
            type: "workflow.approve",
            id: request.id,
            payload: { data: approveReply },
          }));
          return;
        }
        if (request.type !== "workflow.resume") {
          socket.send(JSON.stringify({
            type: request.type,
            id: request.id,
            payload: { version: "test", gitSha: "test" },
          }));
          return;
        }
        if ("refuse" in resume) {
          socket.send(JSON.stringify({
            type: "error",
            id: request.id,
            error: { code: "forbidden", message: resume.refuse },
          }));
          return;
        }
        if ("suspend" in resume) {
          socket.send(JSON.stringify({
            type: "event",
            id: request.id,
            event: {
              kind: "suspended",
              run: {
                id: RUN_ID,
                workflowName: "wipe-drive",
                status: "suspended",
              },
              jobId: "main",
              stepId: "second-gate",
              prompt: "approve again",
            },
          }));
          socket.send(JSON.stringify({ type: "done", id: request.id }));
          return;
        }
        socket.send(JSON.stringify({
          type: "event",
          id: request.id,
          event: {
            kind: "completed",
            run: {
              id: RUN_ID,
              workflowName: "wipe-drive",
              status: resume.status,
            },
          },
        }));
        socket.send(JSON.stringify({ type: "done", id: request.id }));
      };
      return response;
    },
  );
  return {
    url: `ws://127.0.0.1:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

function approveReply(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId: RUN_ID,
    workflowName: "wipe-drive",
    stepName: "gate",
    approved: true,
    decidedBy: "tester",
    reason: null,
    allGatesDecided: true,
    autoResumed: false,
    ...overrides,
  };
}

function remoteArgs(url: string): string[] {
  return [
    "wipe-drive",
    "gate",
    "--run",
    RUN_ID,
    "--resume",
    "--json",
    "--server",
    url,
    "--token",
    "test.token",
  ];
}

function resumeRequests(serve: FakeServe): Record<string, unknown>[] {
  return serve.requests
    .filter((r) => r.type === "workflow.resume")
    .map((r) => r.payload);
}

for (
  const [name, overrides] of [
    ["serve already resumed the run", { autoResumed: true }],
    ["the run's owner resumes it", { ownerResumes: true }],
    ["other gates are pending", {
      allGatesDecided: false,
      pendingGates: {
        approvals: [{ jobName: "main", stepName: "gate-b" }],
        signalWaits: [],
        nestedRuns: [],
      },
    }],
  ] as const
) {
  Deno.test({
    name: `workflow approve --resume --server: sends no resume when ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const serve = fakeServe(approveReply(overrides), { status: "succeeded" });
      try {
        const { lines, exitCode } = await runApprove(remoteArgs(serve.url));
        assertEquals(exitCode, 0);
        assertEquals(resumeRequests(serve), []);
        assertEquals(lines.length, 1);
        assertEquals(JSON.parse(lines[0]).resuming, false);
      } finally {
        await serve.shutdown();
      }
    },
  });
}

for (
  const [status, expectedExit] of [["succeeded", 0], ["failed", 1]] as const
) {
  Deno.test({
    name:
      `workflow approve --resume --server: resumes once with the approval's run, exiting as the ${status} run`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const serve = fakeServe(approveReply({}), { status });
      try {
        const { lines, exitCode } = await runApprove(remoteArgs(serve.url));
        assertEquals(exitCode, expectedExit);
        const resumes = resumeRequests(serve);
        assertEquals(resumes.length, 1);
        assertEquals(resumes[0].workflowIdOrName, "wipe-drive");
        assertEquals(resumes[0].runId, RUN_ID);
        assertEquals(JSON.parse(lines[0]).resuming, true);
      } finally {
        await serve.shutdown();
      }
    },
  });
}

Deno.test({
  name:
    "workflow approve --resume --server: a resume serve refuses fails the command after the approval is reported",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const serve = fakeServe(approveReply({}), {
      refuse: "Not authorized to run workflow wipe-drive",
    });
    try {
      const lines: string[] = [];
      const error = await assertRejects(
        () => runApprove(remoteArgs(serve.url), lines),
        Error,
      );
      assertStringIncludes(error.message, "Not authorized");
      assertEquals(JSON.parse(lines[0]).approved, true);
      assertEquals(resumeRequests(serve).length, 1);
    } finally {
      await serve.shutdown();
    }
  },
});

const PARENT_RUN_ID = "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a";

function nestedApproveReply(): Record<string, unknown> {
  return approveReply({
    awaitingParent: {
      workflowId: "parent-id",
      workflowName: "parent-wf",
      runId: PARENT_RUN_ID,
      resumeCommand: `swamp workflow resume parent-wf --run ${PARENT_RUN_ID}`,
    },
  });
}

function logArgs(url: string): string[] {
  return remoteArgs(url).filter((arg) => arg !== "--json");
}

Deno.test({
  name:
    "workflow approve --resume --server: a nested run that finishes names the parent's resume command on the same server",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const serve = fakeServe(nestedApproveReply(), { status: "succeeded" });
    try {
      const { lines } = await runApprove(logArgs(serve.url));
      assertEquals(resumeRequests(serve).length, 1);
      assertStringIncludes(
        lines.join("\n"),
        `Resume it with: swamp workflow resume parent-wf --run ${PARENT_RUN_ID} --server ${serve.url}`,
      );
    } finally {
      await serve.shutdown();
    }
  },
});

Deno.test({
  name:
    "workflow approve --resume --server: a nested run that suspends again names no parent command",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const serve = fakeServe(nestedApproveReply(), { suspend: true });
    try {
      const { lines } = await runApprove(logArgs(serve.url));
      assertEquals(resumeRequests(serve).length, 1);
      assertEquals(lines.join("\n").includes("parent-wf"), false);
    } finally {
      await serve.shutdown();
    }
  },
});
