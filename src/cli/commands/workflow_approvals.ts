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
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowApprovalsCommand = new Command()
  .name("approvals")
  .description("List all workflow runs awaiting manual approval")
  .example("List pending approvals", "swamp workflow approvals")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "approvals",
    ]);

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    // Use the datastore-aware repositories from the RepositoryContext so the
    // pending-approval scan reads the same workflow-runs path suspended runs
    // are written to. Constructing YamlWorkflowRunRepository(repoDir) directly
    // would bind to repo-local .swamp/workflow-runs/ and miss runs stored in a
    // configured datastore, yielding an empty approvals list.
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const workflows = await workflowRepo.findAll();

    interface PendingApproval {
      workflowName: string;
      runId: string;
      stepName: string;
      suspendedAt: string | undefined;
      prompt: string | undefined;
    }

    const pending: PendingApproval[] = [];

    for (const workflow of workflows) {
      const runs = await runRepo.findAllByWorkflowId(workflow.id);
      for (const run of runs) {
        if (run.status !== "suspended") continue;
        const waiting = run.findWaitingApprovalStep();
        if (!waiting) continue;

        const job = run.getJob(waiting.jobName);
        const step = job?.getStep(waiting.stepName);
        const taskData = workflow.jobs
          .find((j) => j.name === waiting.jobName)?.steps
          .find((s) => s.name === waiting.stepName)?.task.data;

        // A run whose approval deadline has lapsed is no longer actionable —
        // `swamp workflow approve` would reject it — so apply the same
        // deadline check here and drop expired entries from the listing.
        const timeout = evaluateApprovalTimeout(
          step?.startedAt,
          taskData,
          new Date(),
        );
        if (timeout?.expired) continue;

        const prompt = taskData && taskData.type === "manual_approval"
          ? taskData.prompt
          : undefined;

        pending.push({
          workflowName: workflow.name,
          runId: run.id,
          stepName: waiting.stepName,
          suspendedAt: step?.startedAt?.toISOString(),
          prompt,
        });
      }
    }

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({ approvals: pending }, null, 2));
    } else {
      if (pending.length === 0) {
        cliCtx.logger.info("No workflows awaiting approval");
      } else {
        for (const item of pending) {
          cliCtx.logger.info(
            "{workflowName} / {stepName} — {prompt}",
            {
              workflowName: item.workflowName,
              stepName: item.stepName,
              prompt: item.prompt ?? "(no prompt)",
            },
          );
          cliCtx.logger.info(
            "  swamp workflow approve {workflowName} {stepName}",
            { workflowName: item.workflowName, stepName: item.stepName },
          );
          cliCtx.logger.info(
            "  swamp workflow reject  {workflowName} {stepName}",
            { workflowName: item.workflowName, stepName: item.stepName },
          );
          cliCtx.logger.info(
            "  After approval: swamp workflow resume {workflowName}",
            { workflowName: item.workflowName },
          );
        }
      }
    }
  });
