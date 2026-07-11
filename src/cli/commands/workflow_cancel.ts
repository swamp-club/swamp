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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { killProcessTree } from "../../infrastructure/process/process_kill.ts";
import {
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

async function cancelRun(run: WorkflowRun, reason: string): Promise<void> {
  if (run.pid && run.pid !== Deno.pid) {
    await killProcessTree(run.pid);
  }
  run.cancel(reason);
}

async function findAllActiveRuns(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): Promise<
  { run: WorkflowRun; workflowId: WorkflowId; workflowName: string }[]
> {
  const workflows = await workflowRepo.findAll();
  const results: {
    run: WorkflowRun;
    workflowId: WorkflowId;
    workflowName: string;
  }[] = [];

  for (const workflow of workflows) {
    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    for (const run of runs) {
      if (!TERMINAL_STATUSES.has(run.status)) {
        results.push({
          run,
          workflowId: workflow.id,
          workflowName: workflow.name,
        });
      }
    }
  }
  return results;
}

export const workflowCancelCommand = withRemoteOptions(
  new Command()
    .name("cancel")
    .description("Cancel a running workflow run")
    .example(
      "Cancel latest running run",
      "swamp workflow cancel my-workflow",
    )
    .example(
      "Cancel a specific run",
      "swamp workflow cancel my-workflow --run <run-id>",
    )
    .example(
      "Cancel all running runs",
      "swamp workflow cancel --all",
    )
    .example(
      "Cancel with reason",
      "swamp workflow cancel my-workflow --reason 'No longer needed'",
    )
    .example(
      "Cancel via server",
      "swamp workflow cancel --run <run-id> --server ws://localhost:9090",
    )
    .arguments("[workflow_id_or_name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--run <run_id:string>", "Target a specific run ID")
    .option("--all", "Cancel all running workflow runs")
    .option("--reason <reason:string>", "Reason for cancellation"),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "cancel",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      if (!options.run) {
        throw new UserError(
          "Remote cancel requires --run <run-id>. Use 'swamp workflow history search --server' to find run IDs.",
        );
      }
      if (options.all) {
        throw new UserError(
          "--all is not supported with --server",
        );
      }
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const httpUrl = server.replace(/^ws(s?):/, "http$1:");
      const cancelUrl = `${httpUrl}/api/v1/cancel/workflow-run/${
        encodeURIComponent(options.run as string)
      }`;
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const response = await fetch(cancelUrl, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify(body));
      } else if (body.status === "cancelled") {
        cliCtx.logger
          .info`Cancelled run ${options.run as string} on server`;
      } else {
        throw new UserError(
          body.message ??
            `Failed to cancel run ${options.run as string}: ${body.status}`,
        );
      }
      return;
    }

    if (!options.all && !workflowIdOrName) {
      throw new UserError(
        "Provide a workflow name or ID, or use --all to cancel all running runs",
      );
    }

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;
    const reason = options.reason ?? "Cancelled by user";

    if (options.all) {
      const activeRuns = await findAllActiveRuns(workflowRepo, runRepo);
      if (activeRuns.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify({ cancelled: [] }));
        } else {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
        return;
      }

      const cancelled: {
        runId: string;
        workflowName: string;
        previousStatus: string;
      }[] = [];
      for (const { run, workflowId, workflowName } of activeRuns) {
        const previousStatus = run.status;
        await cancelRun(run, reason);
        await runRepo.save(workflowId, run);
        cancelled.push({
          runId: run.id,
          workflowName,
          previousStatus,
        });
      }

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          cancelled,
          count: cancelled.length,
          reason,
        }));
      } else {
        cliCtx.logger
          .info`Cancelled ${cancelled.length} workflow run(s)`;
        for (const entry of cancelled) {
          cliCtx.logger
            .info`  ${entry.workflowName} (${entry.runId}): ${entry.previousStatus} -> cancelled`;
        }
      }
      return;
    }

    // Single workflow cancel path
    const workflow = await workflowRepo.findByName(workflowIdOrName!) ??
      await workflowRepo.findById(
        createWorkflowId(workflowIdOrName!),
      );
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    let run: WorkflowRun;
    if (options.run) {
      const found = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(options.run),
      );
      if (!found) {
        throw new UserError(`Workflow run not found: ${options.run}`);
      }
      run = found;
    } else {
      const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
      const activeRuns = allRuns.filter(
        (r) => !TERMINAL_STATUSES.has(r.status),
      );

      if (activeRuns.length === 0) {
        throw new UserError(
          `No active runs found for workflow "${workflow.name}"`,
        );
      }

      run = activeRuns.reduce((latest, current) => {
        if (!latest.startedAt) return current;
        if (!current.startedAt) return latest;
        return current.startedAt > latest.startedAt ? current : latest;
      });
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new UserError(
        `Run ${run.id} is already in a terminal state (status: ${run.status})`,
      );
    }

    const previousStatus = run.status;
    await cancelRun(run, reason);
    await runRepo.save(createWorkflowId(workflow.id), run);

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({
        runId: run.id,
        workflowName: workflow.name,
        previousStatus,
        status: "cancelled",
        reason,
      }));
    } else {
      cliCtx.logger
        .info`Cancelled run ${run.id} of workflow ${workflow.name}`;
      cliCtx.logger
        .info`Status: ${previousStatus} -> cancelled`;
      if (options.reason) {
        cliCtx.logger.info`Reason: ${reason}`;
      }
    }
  },
);
