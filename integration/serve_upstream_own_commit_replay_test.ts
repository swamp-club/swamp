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
 * the catch-up runs between the suspended save and the root's commit on
 * purpose, as the feed watch's would, through the handle every catch-up of the
 * checkout goes through
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { serveUpstreamLocalRoot } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  catchUpV3HandlesAt,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { setV3DatastoreFaultsForTesting } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { checkpointFrom } from "../src/infrastructure/datastore_v3/commit_log_unit_of_work.ts";
import { currentUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  endCommand,
  MEMBER,
  readCommand,
  serveEnv,
  withScratch,
  writeCommand,
  writeInOpenCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const GRANTS: readonly GrantSpec[] = [
  ...MEMBER,
  { actions: ["read", "write", "run"], kind: "workflow", pattern: "*" },
];

function gateWorkflow(): Workflow {
  return Workflow.create({
    name: `gate-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "approve-me",
            task: StepTask.manualApproval("Approve?"),
          }),
        ],
      }),
    ],
  });
}

async function fileStatus(
  repoDir: string,
  workflow: Workflow,
  run: WorkflowRun,
): Promise<string | undefined> {
  const text = await Deno.readTextFile(
    join(
      swampPath(repoDir, "workflow-runs", workflow.id),
      `workflow-run-${run.id}.yaml`,
    ),
  );
  return text.match(/^status: (\w+)$/m)?.[1];
}

Deno.test({
  name:
    "serve upstream: a catch-up while a run's root is open does not replay the run's own checkpoint over its later save (swamp-club#4249)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const reader = await scratch.client("b");
      const env = serveEnv(serve, "alice-token");
      const root = serveUpstreamLocalRoot(client.repoDir, serve.origin, "");
      const workflow = gateWorkflow();
      await writeCommand(scratch, client, env, async (repos) => {
        await repos.workflowRepo.save(workflow);
      });

      const run = WorkflowRun.create(workflow);
      const afterCatchUp = await writeCommand(
        scratch,
        client,
        env,
        async (repos) => {
          run.start();
          await repos.workflowRunRepo.save(workflow.id, run);
          const unit = currentUnitOfWork();
          if (unit === undefined) throw new Error("no unit is open");
          assertEquals(await checkpointFrom(unit), true);
          run.suspend();
          await repos.workflowRunRepo.save(workflow.id, run);
          await catchUpV3HandlesAt(root);
          return await fileStatus(client.repoDir, workflow, run);
        },
      );

      const atServe = await readCommand(
        scratch,
        reader,
        env,
        (repos) => repos.workflowRunRepo.findById(workflow.id, run.id),
      );
      assertEquals(atServe?.status, "suspended");
      // The catch-up left the run's last save in its file for the root to
      // commit.
      assertEquals(afterCatchUp, "suspended");
      const own = await readCommand(
        scratch,
        client,
        env,
        (repos) => repos.workflowRunRepo.findById(workflow.id, run.id),
      );
      assertEquals(own?.status, "suspended");
    });
  },
});

Deno.test({
  name:
    "serve upstream: a root that fails after its checkpoint has its later save put back to the checkpoint, the commit it sent included (swamp-club#4249)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const env = serveEnv(serve, "alice-token");
      const workflow = gateWorkflow();
      await writeCommand(scratch, client, env, async (repos) => {
        await repos.workflowRepo.save(workflow);
      });

      const run = WorkflowRun.create(workflow);
      // Serve refuses the root's commit of the run, after its checkpoint
      // landed: the unit drops its later save.
      let runCommits = 0;
      setV3DatastoreFaultsForTesting({
        wrapSink: (sink) => ({
          ...sink,
          append: (commit) => {
            if (commit.partition.toString().includes(run.id)) {
              runCommits++;
              if (runCommits === 2) {
                return Promise.reject(
                  new CommitRejectedError("stale-fence", "refused by the test"),
                );
              }
            }
            return sink.append(commit);
          },
        }),
      });
      try {
        await assertRejects(() =>
          writeCommand(scratch, client, env, async (repos) => {
            run.start();
            await repos.workflowRunRepo.save(workflow.id, run);
            const unit = currentUnitOfWork();
            if (unit === undefined) throw new Error("no unit is open");
            assertEquals(await checkpointFrom(unit), true);
            run.suspend();
            await repos.workflowRunRepo.save(workflow.id, run);
          })
        );
      } finally {
        setV3DatastoreFaultsForTesting(undefined);
      }
      assertEquals(runCommits, 2);

      // The dropped save is undone once no unit is open: the checkout's file
      // is the checkpoint serve holds, not the save that never committed.
      assertEquals(await fileStatus(client.repoDir, workflow, run), "running");
      const own = await readCommand(
        scratch,
        client,
        env,
        (repos) => repos.workflowRunRepo.findById(workflow.id, run.id),
      );
      assertEquals(own?.status, "running");
    });
  },
});

Deno.test({
  name:
    "serve upstream: a catch-up that meets a checkpoint before serve's reply does leaves a newer write of the run alone (swamp-club#4249)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const env = serveEnv(serve, "alice-token");
      const root = serveUpstreamLocalRoot(client.repoDir, serve.origin, "");
      const workflow = gateWorkflow();
      await writeCommand(scratch, client, env, async (repos) => {
        await repos.workflowRepo.save(workflow);
      });

      const run = WorkflowRun.create(workflow);
      const path = join(
        swampPath(client.repoDir, "workflow-runs", workflow.id),
        `workflow-run-${run.id}.yaml`,
      );
      // Serve has the checkpoint and its feed has brought it back, but its
      // reply has not reached the unit yet. Meanwhile the run's file was
      // written again, as a save running beside the checkpoint writes it.
      let duringSend: string | undefined;
      setV3DatastoreFaultsForTesting({
        wrapSink: (sink) => ({
          ...sink,
          append: async (commit) => {
            const result = await sink.append(commit);
            if (
              duringSend === undefined &&
              commit.partition.toString().includes(run.id)
            ) {
              const text = await Deno.readTextFile(path);
              await Deno.writeTextFile(
                path,
                text.replace(/^status: running$/m, "status: suspended"),
              );
              await catchUpV3HandlesAt(root);
              duringSend = await fileStatus(client.repoDir, workflow, run);
            }
            return result;
          },
        }),
      });
      try {
        await writeCommand(scratch, client, env, async (repos) => {
          run.start();
          await repos.workflowRunRepo.save(workflow.id, run);
          const unit = currentUnitOfWork();
          if (unit === undefined) throw new Error("no unit is open");
          assertEquals(await checkpointFrom(unit), true);
          run.suspend();
          await repos.workflowRunRepo.save(workflow.id, run);
        });
      } finally {
        setV3DatastoreFaultsForTesting(undefined);
      }
      assertEquals(duringSend, "suspended");
    });
  },
});

async function withRunCommitRefused(
  run: WorkflowRun,
  fn: () => Promise<void>,
): Promise<number> {
  let runCommits = 0;
  setV3DatastoreFaultsForTesting({
    wrapSink: (sink) => ({
      ...sink,
      append: (commit) => {
        if (commit.partition.toString().includes(run.id)) {
          runCommits++;
          if (runCommits === 2) {
            return Promise.reject(
              new CommitRejectedError("stale-fence", "refused by the test"),
            );
          }
        }
        return sink.append(commit);
      },
    }),
  });
  try {
    await fn();
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
  }
  return runCommits;
}

function checkpointThenSuspend(
  workflow: Workflow,
  run: WorkflowRun,
): (repos: RepositoryContext) => Promise<void> {
  return async (repos) => {
    run.start();
    await repos.workflowRunRepo.save(workflow.id, run);
    const unit = currentUnitOfWork();
    if (unit === undefined) throw new Error("no unit is open");
    assertEquals(await checkpointFrom(unit), true);
    run.suspend();
    await repos.workflowRunRepo.save(workflow.id, run);
  };
}

Deno.test({
  name:
    "serve upstream: a root that waits on the recovery of a dropped save does not make the recovery keep it (swamp-club#4257)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const env = serveEnv(serve, "alice-token");
      const root = serveUpstreamLocalRoot(client.repoDir, serve.origin, "");
      const workflow = gateWorkflow();
      await writeCommand(scratch, client, env, async (repos) => {
        await repos.workflowRepo.save(workflow);
      });

      const run = WorkflowRun.create(workflow);
      // The command's root drops its save after the checkpoint landed; its
      // teardown has not recovered the drop yet.
      const runCommits = await withRunCommitRefused(run, async () => {
        await assertRejects(() =>
          writeInOpenCommand(
            scratch,
            client,
            env,
            checkpointThenSuspend(workflow, run),
          )
        );
      });
      assertEquals(runCommits, 2);
      try {
        const handle = v3DatastoreFor(client.repoDir, { path: root });
        assert(handle.droppedWork() !== undefined, "the command's handle");
        assertEquals(
          await fileStatus(client.repoDir, workflow, run),
          "suspended",
        );
        const engine = handle.engineFor(() => Promise.resolve(), () => {
          throw new Error("no run repository needed");
        });
        // A root opened while the recovery replays waits for it, and counts
        // as open from the call.
        const recovering = handle.recoverDroppedWork();
        const waiting = engine.runRoot({}, () => Promise.resolve());
        assertEquals(handle.droppedWork()?.openUnits, 1);
        assertEquals(await recovering, "recovered");
        await waiting;
        assertEquals(
          await fileStatus(client.repoDir, workflow, run),
          "running",
        );
      } finally {
        await endCommand();
      }
    });
  },
});

Deno.test({
  name:
    "serve upstream: a catch-up while another root is open puts a dropped save back to the checkpoint it sent (swamp-club#4257)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: GRANTS });
      const client = await scratch.client("a");
      const env = serveEnv(serve, "alice-token");
      const root = serveUpstreamLocalRoot(client.repoDir, serve.origin, "");
      const workflow = gateWorkflow();
      await writeCommand(scratch, client, env, async (repos) => {
        await repos.workflowRepo.save(workflow);
      });

      const run = WorkflowRun.create(workflow);
      // Root B opens in the same command and stays open while the
      // command's root, A, drops its save.
      const release = Promise.withResolvers<void>();
      let other: Promise<void> | undefined;
      let duringB: string | undefined;
      const runCommits = await withRunCommitRefused(run, async () => {
        try {
          await assertRejects(() =>
            writeInOpenCommand(scratch, client, env, async (repos) => {
              const handle = v3DatastoreFor(client.repoDir, { path: root });
              const engine = handle.engineFor(() => Promise.resolve(), () => {
                throw new Error("no run repository needed");
              });
              other = engine.runRoot({}, () => release.promise);
              await checkpointThenSuspend(workflow, run)(repos);
            })
          );
          const handle = v3DatastoreFor(client.repoDir, { path: root });
          assertEquals(handle.droppedWork()?.openUnits, 1);
          assertEquals(
            await fileStatus(client.repoDir, workflow, run),
            "suspended",
          );
          // A catch-up during B meets A's checkpoint: A's save never
          // committed, so the file is the checkpoint's again.
          await catchUpV3HandlesAt(root);
          duringB = await fileStatus(client.repoDir, workflow, run);
        } finally {
          release.resolve();
          try {
            await other;
          } finally {
            await endCommand();
          }
        }
      });
      assertEquals(runCommits, 2);
      assertEquals(duringB, "running");
    });
  },
});
