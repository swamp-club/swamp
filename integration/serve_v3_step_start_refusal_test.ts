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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  type StepRun,
  WorkflowRun,
} from "../src/domain/workflows/workflow_run.ts";
import { StepStartUnrecordedError } from "../src/domain/workflows/step_start.ts";
import { COMMIT_UNREACHABLE_CODE } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { setV3DatastoreFaultsForTesting } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { WorkflowRunCheckpointer } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  MEMBER,
  readCommand,
  type Scratch,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";

await initializeLogging({});

/**
 * a member's gate run, suspended at serve, then moved back into running as
 * resume does, with `change` applied to the member's copy first
 */
async function resumeGateRun(
  scratch: Scratch,
  change: (gate: StepRun) => void,
): Promise<{ failure: unknown; atServe: string | undefined }> {
  const serve = await scratch.serve({
    grants: [
      ...MEMBER,
      { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
    ],
  });
  const client = await scratch.client("a");
  const env = serveEnv(serve, "alice-token");
  const workflow = Workflow.create({
    name: `gated-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("Go?") }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const gate = job.getStep("gate")!;
  gate.start();
  gate.waitForApproval();
  run.suspend();
  await writeCommand(scratch, client, env, async (repos) => {
    await repos.workflowRepo.save(workflow);
    await repos.workflowRunRepo.save(workflow.id, run);
  });

  let failure: unknown;
  try {
    change(gate);
    run.resumeFromSuspended({ pid: Deno.pid });
    await writeCommand(scratch, client, env, async (repos) => {
      await repos.workflowRunRepo.save(workflow.id, run);
      try {
        await new WorkflowRunCheckpointer(repos).checkpoint(run);
      } catch (error) {
        failure = error;
      }
    });
  } catch {
    // the root's own commit of the same record fails as the append did
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
  }
  const atServe = await readCommand(
    scratch,
    client,
    env,
    (repos) => repos.workflowRunRepo.findById(workflow.id, run.id),
  );
  return { failure, atServe: atServe?.status };
}

Deno.test({
  name:
    "serve upstream: a forged run record serve refuses on resume keeps its refusal code, with no outage advice (swamp-club#4368)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const { failure, atServe } = await resumeGateRun(scratch, (gate) => {
        gate.recordApprovalDecision({
          approved: true,
          decidedBy: "user:alice",
          decidedAt: new Date().toISOString(),
        });
      });

      assert(failure instanceof StepStartUnrecordedError, String(failure));
      assertEquals(failure.code, "forbidden", failure.message);
      assert(!failure.message.includes("reachable"), failure.message);
      assertEquals(exitCodeForError(failure), 1);
      assertEquals(atServe, "suspended");
    });
  },
});

Deno.test({
  name:
    "serve upstream: a run record a cut connection stops on resume is still commit-unreachable, exit 75 (swamp-club#4368)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const { failure, atServe } = await resumeGateRun(scratch, () => {
        setV3DatastoreFaultsForTesting({
          wrapSink: (sink) => ({
            ...sink,
            append: () =>
              Promise.reject(
                Object.assign(new Error("connect ECONNREFUSED"), {
                  code: "ECONNREFUSED",
                }),
              ),
          }),
        });
      });

      assert(failure instanceof StepStartUnrecordedError, String(failure));
      assertEquals(failure.code, COMMIT_UNREACHABLE_CODE, failure.message);
      assert(failure.message.includes("reachable"), failure.message);
      assertEquals(exitCodeForError(failure), 75);
      assertEquals(atServe, "suspended");
    });
  },
});
