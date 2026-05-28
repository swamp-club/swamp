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
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRejectCommand = new Command()
  .name("reject")
  .description("Reject a manual approval step in a suspended workflow run")
  .example(
    "Reject a step",
    "swamp workflow reject deploy-with-gate verify-build",
  )
  .example(
    "Reject with reason",
    "swamp workflow reject deploy-with-gate verify-build --reason 'Not ready'",
  )
  .arguments("<workflow_id_or_name:string> <step_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--reason <reason:string>", "Reason for rejection")
  .action(
    async function (
      options: AnyOptions,
      workflowIdOrName: string,
      stepName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "workflow",
        "reject",
      ]);

      const { repoDir } = await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      const workflowRepo = new YamlWorkflowRepository(repoDir);
      const runRepo = new YamlWorkflowRunRepository(repoDir);

      const { run, workflowName, workflowId } = await resolveSuspendedRun(
        workflowRepo,
        runRepo,
        workflowIdOrName,
      );

      const waiting = run.findWaitingApprovalStep();
      if (!waiting || waiting.stepName !== stepName) {
        throw new UserError(
          `Step "${stepName}" is not awaiting approval in the suspended run`,
        );
      }

      const job = run.getJob(waiting.jobName);
      const step = job?.getStep(stepName);
      if (!step) {
        throw new UserError(`Step "${stepName}" not found in run`);
      }

      const decidedBy = Deno.env.get("USER") ??
        Deno.env.get("USERNAME") ?? "unknown";
      step.recordApprovalDecision({
        approved: false,
        reason: options.reason,
        decidedBy,
        decidedAt: new Date().toISOString(),
      });
      step.fail(options.reason ?? "Approval rejected");
      job!.fail();
      run.complete();
      await runRepo.save(createWorkflowId(workflowId), run);

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          runId: run.id,
          workflowName,
          stepName,
          approved: false,
          reason: options.reason ?? null,
        }));
      } else {
        cliCtx.logger
          .info`Rejected step ${stepName} in workflow ${workflowName}`;
      }
    },
  );
