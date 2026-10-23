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
 * A v3 command prints its result only once its root has committed
 * (swamp-club#3759). Each case runs the CLI in-process against a v3
 * filesystem datastore whose commit fails after the command has done its
 * work: the chunk storage stops answering, as an unreachable bucket does,
 * or the commit's append fails. The command must fail without a success
 * document or line on stdout, and keep nothing.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  COMMIT_UNREACHABLE_CODE,
  RUN_PARTLY_COMMITTED_CODE,
  RunPartlyCommittedError,
} from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import { closeV3DatastoresAfterFailure } from "../src/cli/v3_teardown.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { writerMarkerPath } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import {
  V3_STORAGE_UNREACHABLE_CODE,
  V3StorageUnreachableError,
} from "../src/domain/datastore_v3/writer_lease.ts";
import {
  CATCH_UP_UNREACHABLE_CODE,
  ReadModelCatchUpUnreachableError,
} from "../src/domain/datastore_v3/read_model.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import {
  type CapturedCli,
  runCli,
  runCliCapturing,
} from "./usecase_sync_fixtures.ts";
import {
  faults,
  payloadCommitted,
  registerBigWriter,
  seedModel,
  seedWorkflow,
  withFaults,
} from "./v3_commit_fault_helpers.ts";

await initializeLogging({});

/**
 * The run failed with the unreachable-storage error, naming that its steps
 * ran, and nothing on stdout says it succeeded. In log mode its progress
 * still streamed: only its result was held.
 */
function assertUnreachableRun(
  result: CapturedCli,
  mode: "json" | "log",
): void {
  assertFailedWithoutSuccess(result);
  assert(result.error instanceof UserError, String(result.error));
  assertEquals(result.error.code, COMMIT_UNREACHABLE_CODE);
  assertStringIncludes(result.error.message, "nothing this command changed");
  assertStringIncludes(result.error.message, "steps had already run");
  assertEquals(exitCodeForError(result.error), 75);
  if (mode === "log") {
    assert(result.stdout.length > 0, "log mode printed no progress");
  } else {
    assertEquals(result.stdout, [], "--json printed before the commit");
  }
}

/**
 * The workflow run failed with the run-partly-committed error (swamp-club#3802):
 * its start checkpoint had committed its record, so it names the run, the
 * recover command, and that its steps ran, and exits 1, not 75. Nothing on
 * stdout says it succeeded.
 */
function assertPartlyCommittedRun(
  result: CapturedCli,
  mode: "json" | "log",
  workflowId: string,
): void {
  assertFailedWithoutSuccess(result);
  assert(result.error instanceof RunPartlyCommittedError, String(result.error));
  assertEquals(result.error.code, RUN_PARTLY_COMMITTED_CODE);
  assertEquals(result.error.runs.length, 1);
  const [run] = result.error.runs;
  assertEquals(run.workflowId, workflowId);
  assertStringIncludes(
    result.error.message,
    `swamp workflow recover ${workflowId} --run ${run.runId}`,
  );
  assertStringIncludes(result.error.message, "steps had already run");
  assert(
    !result.error.message.includes("nothing this command changed"),
    result.error.message,
  );
  assertEquals(exitCodeForError(result.error), 1);
  if (mode === "log") {
    assert(result.stdout.length > 0, "log mode printed no progress");
  } else {
    assertEquals(result.stdout, [], "--json printed before the commit");
  }
}

/** The command failed, and nothing on stdout says it succeeded. */
function assertFailedWithoutSuccess(result: CapturedCli): void {
  const text = result.stdout.join("\n");
  assert(
    result.error !== undefined || result.exitCode !== 0,
    `the command succeeded:\n${text}`,
  );
  assert(!text.includes("succeeded"), `stdout reported success:\n${text}`);
  assert(!text.includes("Completed"), `stdout reported success:\n${text}`);
}

Deno.test({
  name:
    "v3 output after commit: a method run whose commit lands prints its success and is kept (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const type = registerBigWriter(false);
      try {
        const name = `big-${crypto.randomUUID().slice(0, 8)}`;
        await seedModel(repos, type, name);
        const result = await runCliCapturing({
          args: [
            "model",
            "method",
            "run",
            name,
            "write",
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assertEquals(result.error, undefined);
        assertEquals(result.exitCode, 0);
        assert(
          result.stdout.join("\n").includes('"status": "succeeded"'),
          result.stdout.join("\n"),
        );
        assertEquals(await payloadCommitted(repos, type), true);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

for (const mode of ["json", "log"] as const) {
  const flags = mode === "json" ? ["--json"] : [];

  Deno.test({
    name:
      `v3 output after commit: a method run whose commit cannot reach the storage prints no success (${mode}), fails, and keeps nothing (swamp-club#3759)`,
    ignore: Deno.build.os === "windows",
    async fn() {
      await withFaults(async (repos) => {
        const type = registerBigWriter();
        try {
          const name = `big-${crypto.randomUUID().slice(0, 8)}`;
          await seedModel(repos, type, name);
          const result = await runCliCapturing({
            args: [
              "model",
              "method",
              "run",
              name,
              "write",
              "--repo-dir",
              repos.repoA,
              ...flags,
            ],
          });
          assertUnreachableRun(result, mode);
          assertEquals(await payloadCommitted(repos, type), false);
        } finally {
          modelRegistry.invalidateType(type);
        }
      });
    },
  });

  Deno.test({
    name:
      `v3 output after commit: a workflow run whose end cannot reach the storage after its start checkpoint committed prints no success (${mode}), says the run is partly committed, and keeps none of its data (swamp-club#3759, swamp-club#3802)`,
    ignore: Deno.build.os === "windows",
    async fn() {
      await withFaults(async (repos) => {
        const type = registerBigWriter();
        try {
          const name = `big-${crypto.randomUUID().slice(0, 8)}`;
          await seedModel(repos, type, name);
          const workflow = await seedWorkflow(repos, name);
          const result = await runCliCapturing({
            args: [
              "workflow",
              "run",
              workflow.name,
              "--repo-dir",
              repos.repoA,
              ...flags,
            ],
          });
          assertPartlyCommittedRun(result, mode, workflow.id);
          assertEquals(await payloadCommitted(repos, type), false);
        } finally {
          modelRegistry.invalidateType(type);
        }
      });
    },
  });
}

Deno.test({
  name:
    "v3 output after commit: after a workflow run whose end could not reach the storage, history search and history get agree on the run's status (swamp-club#3802)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const type = registerBigWriter();
      try {
        const name = `big-${crypto.randomUUID().slice(0, 8)}`;
        await seedModel(repos, type, name);
        const workflow = await seedWorkflow(repos, name);
        const run = await runCliCapturing({
          args: ["workflow", "run", workflow.name, "--repo-dir", repos.repoA],
        });
        assert(run.error instanceof RunPartlyCommittedError, String(run.error));
        const runId = run.error.runs[0].runId;
        // The CLI's teardown after a failed command, still cut off.
        await closeV3DatastoresAfterFailure(run.error);
        faults.storageDown = false;
        const search = await runCliCapturing({
          args: [
            "workflow",
            "history",
            "search",
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assertEquals(search.error, undefined, String(search.error));
        const get = await runCliCapturing({
          args: [
            "workflow",
            "history",
            "get",
            runId,
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assertEquals(get.error, undefined, String(get.error));
        const got = JSON.parse(get.stdout.join("\n")) as { status: string };
        const found = (JSON.parse(search.stdout.join("\n")) as {
          results: { id?: string; runId?: string; status: string }[];
        }).results.find((result) => (result.id ?? result.runId) === runId);
        assert(found !== undefined, search.stdout.join("\n"));
        assertEquals(got.status, "running", "history get");
        assertEquals(found.status, got.status, "history search");
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

Deno.test({
  name:
    "v3 output after commit: a checkout whose catch-up cannot reach the storage fails with the catch-up code and exit 75, and the next command finishes it (swamp-club#3802)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const type = registerBigWriter(false);
      try {
        const name = `big-${crypto.randomUUID().slice(0, 8)}`;
        await seedModel(repos, type, name);
        const written = await runCliCapturing({
          args: [
            "model",
            "method",
            "run",
            name,
            "write",
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assertEquals(written.error, undefined, String(written.error));
        // B has not applied A's commit, whose content is in chunks.
        faults.storageDown = true;
        const cutOff = await runCliCapturing({
          args: [
            "workflow",
            "history",
            "search",
            "--repo-dir",
            repos.repoB,
            "--json",
          ],
        });
        assert(
          cutOff.error instanceof ReadModelCatchUpUnreachableError,
          String(cutOff.error),
        );
        assertEquals(cutOff.error.code, CATCH_UP_UNREACHABLE_CODE);
        assertStringIncludes(cutOff.error.message, "nothing was changed");
        assertStringIncludes(cutOff.error.message, "next command finishes");
        assertEquals(exitCodeForError(cutOff.error), 75);
        faults.storageDown = false;
        const next = await runCliCapturing({
          args: [
            "workflow",
            "history",
            "search",
            "--repo-dir",
            repos.repoB,
            "--json",
          ],
        });
        assertEquals(next.error, undefined, String(next.error));
        assertEquals(next.exitCode, 0);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

Deno.test({
  name:
    "v3 output after commit: an interrupted writer's recovery cut off from the storage while the lease is taken fails with the storage-unreachable code, not the marker advice (swamp-club#3802)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const type = registerBigWriter(false);
      try {
        const name = `big-${crypto.randomUUID().slice(0, 8)}`;
        await seedModel(repos, type, name);
        const written = await runCliCapturing({
          args: [
            "model",
            "method",
            "run",
            name,
            "write",
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assertEquals(written.error, undefined, String(written.error));
        await closeV3Datastores();
        // A writer that ended without tearing down, which this process cannot
        // judge: the next writer replays every commit, chunked ones included.
        await Deno.writeTextFile(
          writerMarkerPath(repos.repoA),
          JSON.stringify({
            hostname: Deno.hostname(),
            pid: 2147483646,
            since: 0,
          }),
        );
        faults.storageDown = true;
        const cutOff = await runCliCapturing({
          args: [
            "model",
            "method",
            "run",
            name,
            "write",
            "--repo-dir",
            repos.repoA,
            "--json",
          ],
        });
        assert(
          cutOff.error instanceof V3StorageUnreachableError,
          String(cutOff.error),
        );
        assertEquals(cutOff.error.code, V3_STORAGE_UNREACHABLE_CODE);
        assert(
          !cutOff.error.message.includes("delete"),
          cutOff.error.message,
        );
        assertEquals(exitCodeForError(cutOff.error), 75);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

Deno.test({
  name:
    "v3 output after commit: a workflow approve whose commit fails prints no result and fails (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const workflow = await seedWorkflow(repos, "unused", [
        Step.create({
          name: "gate",
          task: StepTask.manualApproval("Proceed?"),
        }),
      ]);
      await runCli({
        args: [
          "workflow",
          "run",
          workflow.name,
          "--repo-dir",
          repos.repoA,
          "--json",
        ],
      });
      const [suspended] = await repos.a.repoContext.workflowRunRepo
        .findSummariesByStatus(workflow.id, "suspended");
      assert(suspended !== undefined, "the run waits for its approval");

      faults.appendFails = true;
      const result = await runCliCapturing({
        args: [
          "workflow",
          "approve",
          workflow.name,
          "gate",
          `--run=${suspended.id}`,
          "--repo-dir",
          repos.repoA,
          "--json",
        ],
      });
      assert(result.error !== undefined, "the approval succeeded");
      assertEquals(result.stdout, [], "the approval's result was printed");
    });
  },
});
