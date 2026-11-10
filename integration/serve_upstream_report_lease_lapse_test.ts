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
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { waitFor } from "@swamp-club/swamp-testing";
import { workflowRunCommand } from "../src/cli/commands/workflow_run.ts";
import { registerCompletionTypes } from "../src/cli/completion_types.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  endCommand,
  readCommand,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";
import {
  BARRIER_REPORT,
  registerBarrierReport,
} from "./workflow_report_barrier.ts";

await initializeLogging({});

// alice-token authenticates as user:caller
const ALICE_ALL: readonly GrantSpec[] = [
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "caller", actions: ["read", "write"], kind: "data", pattern: "*" },
  {
    user: "caller",
    actions: ["read", "write", "run"],
    kind: "workflow",
    pattern: "*",
  },
];

Deno.test({
  name:
    "workflow run: the workflow's lease ending while its reports run fails only the reports; the run keeps its succeeded result and exit code",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: ALICE_ALL,
        managedConfig: true,
      });
      const alice = await scratch.client("a", { managedConfig: true });
      const env = serveEnv(serve, "alice-token");
      const workflow = Workflow.create({
        name: "lapsing-report",
        reports: { require: [BARRIER_REPORT] },
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "check",
            task: StepTask.assert("true", "always holds"),
          })],
        })],
      });
      await writeCommand(
        scratch,
        alice,
        env,
        (repos) => repos.workflowRepo.save(workflow),
      );
      const dir = join(scratch.dir, "barrier");
      await Deno.mkdir(dir);
      // the report holds the workflow's lease until the test has ended it
      registerBarrierReport(dir, "member", ["member", "released"], 120_000);

      const exitCodeBefore = Deno.exitCode;
      Deno.exitCode = 0;
      let thrown: unknown;
      let exitCode: number;
      try {
        const run = withClientEnv(
          scratch,
          env,
          ["workflow", "run"],
          async () => {
            const root = registerCompletionTypes(new Command())
              .globalOption("--json", "JSON output")
              .command("cmd", workflowRunCommand);
            // as mod.ts does for a v3 checkout: it runs locally, serve its
            // upstream
            setImplicitServeRouting(false);
            try {
              await root.parse([
                "cmd",
                workflow.name,
                "--json",
                "--repo-dir",
                alice.repoDir,
              ]);
            } finally {
              resetImplicitServeRouting();
              await endCommand();
            }
          },
        ).catch((error) => {
          thrown = error;
        });
        try {
          await waitFor(
            () => Deno.stat(join(dir, "member")).then(() => true, () => false),
            "the member's report at its barrier",
            { timeoutMs: 120_000, intervalMs: 20 },
          );
          const released = await serve.forceRelease("workflow", workflow.id);
          assertEquals(released.principal, "user:caller");
          // the member's next renewal finds the lease ended, as a lapse does
          const before = await serve.refusedRenewals();
          await waitFor(
            async () => await serve.refusedRenewals() > before,
            "the member's lease to lapse",
            { timeoutMs: 60_000, intervalMs: 200 },
          );
        } finally {
          await Deno.writeTextFile(join(dir, "released"), "");
        }
        await run;
        exitCode = Deno.exitCode;
      } finally {
        Deno.exitCode = exitCodeBefore;
      }

      assertEquals(thrown, undefined);
      assertEquals(exitCode, 0);
      const latest = await readCommand(
        scratch,
        alice,
        env,
        (repos) => repos.workflowRunRepo.findLatestByWorkflowId(workflow.id),
      );
      assertEquals(latest?.status, "succeeded");
      // the reports' save was refused, so the record names none of them
      assertEquals(latest?.workflowDataArtifacts ?? [], []);
    });
  },
});
