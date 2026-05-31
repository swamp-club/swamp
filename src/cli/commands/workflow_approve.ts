// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveSuspendedRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { evaluateApprovalTimeout } from "../../domain/workflows/approval_timeout.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowApproveCommand = new Command()
  .name("approve")
  .description("Approve a manual approval step in a suspended workflow run")
  .example(
    "Approve by workflow name",
    "swamp workflow approve deploy-with-gate verify-build",
  )
  .example(
    "Approve with reason",
    "swamp workflow approve deploy-with-gate verify-build --reason 'Verified'",
  )
  .arguments("<workflow_id_or_name:string> <step_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--reason <reason:string>", "Reason for approval")
  .option("--run <run_id:string>", "Target a specific run ID")
  .action(
    async function (
      options: AnyOptions,
      workflowIdOrName: string,
      stepName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "workflow",
        "approve",
      ]);

      const { repoContext } = await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      // Use the datastore-aware repositories from the RepositoryContext so the
      // suspended-run lookup (and the post-approval save) resolve the same
      // workflow-runs path the run was written to. Constructing
      // YamlWorkflowRunRepository(repoDir) directly would bind to repo-local
      // .swamp/workflow-runs/ and miss runs stored in a configured datastore.
      const workflowRepo = repoContext.workflowRepo;
      const runRepo = repoContext.workflowRunRepo;

      const { run, workflowName, workflow } = await resolveSuspendedRun(
        workflowRepo,
        runRepo,
        workflowIdOrName,
        options.run,
      );

      let step:
        | import("../../domain/workflows/workflow_run.ts").StepRun
        | undefined;
      let jobName: string | undefined;
      for (const job of run.jobs) {
        const s = job.getStep(stepName);
        if (s && s.status === "waiting_approval") {
          step = s;
          jobName = job.jobName;
          break;
        }
      }
      if (!step || !jobName) {
        throw new UserError(
          `Step "${stepName}" is not awaiting approval in the suspended run`,
        );
      }

      {
        const wfJob = workflow.jobs.find((j) => j.name === jobName);
        const wfStep = wfJob?.steps.find((s) => s.name === stepName);
        const timeout = evaluateApprovalTimeout(
          step.startedAt,
          wfStep?.task.data,
          new Date(),
        );
        if (timeout?.expired) {
          throw new UserError(
            `Approval timed out: step "${stepName}" has been waiting ${
              Math.round(timeout.elapsedSeconds)
            }s ` +
              `(timeout: ${timeout.timeoutSeconds}s)`,
          );
        }
      }

      const decidedBy = Deno.env.get("USER") ??
        Deno.env.get("USERNAME") ?? "unknown";
      step.recordApprovalDecision({
        approved: true,
        reason: options.reason,
        decidedBy,
        decidedAt: new Date().toISOString(),
      });
      step.succeed();
      await runRepo.save(createWorkflowId(run.workflowId), run);

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          runId: run.id,
          workflowName,
          stepName,
          approved: true,
          decidedBy,
          reason: options.reason ?? null,
        }));
      } else {
        cliCtx.logger
          .info`Approved step ${stepName} in workflow ${workflowName}`;
        cliCtx.logger
          .info`After approval: swamp workflow resume ${workflowName}`;
      }
    },
  );
