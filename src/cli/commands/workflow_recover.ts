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
  assessRecoveryForRun,
  findInterruptedRun,
} from "../../domain/workflows/recovery_assessment.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowRecoverCommand = new Command()
  .name("recover")
  .description(
    "Recover an interrupted workflow run from its last checkpoint. " +
      "Resets unknown steps to pending so 'swamp workflow resume' can re-execute them.",
  )
  .example(
    "Assess recovery eligibility",
    "swamp workflow recover deploy-pipeline --assess-only",
  )
  .example(
    "Recover and prepare for resume",
    "swamp workflow recover deploy-pipeline",
  )
  .example(
    "Acknowledge re-execution risk for unguarded steps",
    "swamp workflow recover deploy-pipeline --acknowledge-unknown",
  )
  .arguments("<workflow_id_or_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--run <run_id:string>", "Target a specific interrupted run ID")
  .option(
    "--acknowledge-unknown",
    "Accept re-execution risk for steps without guard expressions",
    { default: false },
  )
  .option(
    "--assess-only",
    "Show recovery assessment without modifying the run",
    { default: false },
  )
  .action(
    async function (
      options: AnyOptions,
      workflowIdOrName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "workflow",
        "recover",
      ]);

      const repoDir = resolveRepoDir(options);
      const { repoContext } = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: cliCtx.outputMode,
      });

      const workflow = await repoContext.workflowRepo.findByName(
        workflowIdOrName,
      );
      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }

      const run = await findInterruptedRun(
        workflow,
        repoContext.workflowRunRepo,
        options.run as string | undefined,
      );
      if (!run) {
        throw new UserError(
          options.run
            ? `Interrupted run ${options.run} not found`
            : `No interrupted runs found for workflow "${workflow.name}"`,
        );
      }

      const assessment = await assessRecoveryForRun(workflow, run);

      if (cliCtx.outputMode === "json") {
        writeOutput(JSON.stringify(assessment, null, 2));
        if (options.assessOnly) return;
      }

      if (options.assessOnly) {
        writeOutput(`Recovery assessment for "${workflowIdOrName}":`);
        writeOutput(`  Run ID: ${run.id}`);
        writeOutput(`  Can auto-recover: ${assessment.canAutoRecover}`);
        if (assessment.reason) {
          writeOutput(`  Reason: ${assessment.reason}`);
        }
        if (assessment.guardedSteps.length > 0) {
          writeOutput(
            `  Guarded steps (auto-recoverable): ${
              assessment.guardedSteps.join(", ")
            }`,
          );
        }
        if (assessment.unguardedSteps.length > 0) {
          writeOutput(
            `  Unguarded steps (require --acknowledge-unknown): ${
              assessment.unguardedSteps.join(", ")
            }`,
          );
        }
        if (assessment.fingerprintMismatch) {
          writeOutput(
            `  Fingerprint mismatch — use 'swamp workflow resume --from <step>' instead`,
          );
        }
        return;
      }

      if (assessment.fingerprintMismatch) {
        throw new UserError(assessment.reason!);
      }

      if (!assessment.canAutoRecover && !options.acknowledgeUnknown) {
        throw new UserError(
          `Cannot auto-recover: ${assessment.reason}\n` +
            `Unguarded steps: ${assessment.unguardedSteps.join(", ")}\n` +
            `Use --acknowledge-unknown to accept re-execution risk.`,
        );
      }

      run.resetUnknownStepsForRecovery();
      await repoContext.workflowRunRepo.save(workflow.id, run);

      writeOutput(
        `Recovered run ${run.id} — unknown steps reset to pending.`,
      );
      writeOutput(
        `Resume with: swamp workflow resume ${workflowIdOrName} --run ${run.id}`,
      );
    },
  );
