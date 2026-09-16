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
import type { RecoveryAssessment } from "../../domain/workflows/execution_service.ts";
import { computeWorkflowFingerprint } from "../../domain/workflows/workflow_fingerprint.ts";
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

      const allRuns = await repoContext.workflowRunRepo.findAllByWorkflowId(
        workflow.id,
      );
      const interruptedRuns = allRuns.filter((r) => r.status === "interrupted");
      if (interruptedRuns.length === 0) {
        throw new UserError(
          `No interrupted runs found for workflow "${workflow.name}"`,
        );
      }

      const targetRunId = options.run as string | undefined;
      const run = targetRunId
        ? interruptedRuns.find((r) => r.id === targetRunId)
        : interruptedRuns[0];
      if (!run) {
        throw new UserError(
          `Interrupted run ${targetRunId} not found`,
        );
      }

      // Check fingerprint drift
      let fingerprintMismatch = false;
      if (run.runPlan?.fingerprint) {
        const currentFingerprint = await computeWorkflowFingerprint(workflow);
        if (currentFingerprint !== run.runPlan.fingerprint) {
          fingerprintMismatch = true;
        }
      }

      // Classify unknown steps by guard presence
      const unknownStepNames = run.unknownSteps();
      const guardedSteps: string[] = [];
      const unguardedSteps: string[] = [];

      for (const stepName of unknownStepNames) {
        const step = workflow.jobs
          .flatMap((j) => j.steps)
          .find((s) => s.name === stepName);
        if (step?.guard) {
          guardedSteps.push(stepName);
        } else {
          unguardedSteps.push(stepName);
        }
      }

      const assessment: RecoveryAssessment = {
        canAutoRecover: !fingerprintMismatch && unguardedSteps.length === 0,
        reason: fingerprintMismatch
          ? "Workflow definition changed since the run started — use 'swamp workflow resume --from <step>' instead"
          : unguardedSteps.length > 0
          ? `${unguardedSteps.length} unknown step(s) lack guard expressions — operator acknowledgement required`
          : undefined,
        guardedSteps,
        unguardedSteps,
        runId: run.id,
        workflowId: workflow.id,
        fingerprintMismatch,
      };

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
        if (guardedSteps.length > 0) {
          writeOutput(
            `  Guarded steps (auto-recoverable): ${guardedSteps.join(", ")}`,
          );
        }
        if (unguardedSteps.length > 0) {
          writeOutput(
            `  Unguarded steps (require --acknowledge-unknown): ${
              unguardedSteps.join(", ")
            }`,
          );
        }
        if (fingerprintMismatch) {
          writeOutput(
            `  Fingerprint mismatch — use 'swamp workflow resume --from <step>' instead`,
          );
        }
        return;
      }

      if (fingerprintMismatch) {
        throw new UserError(assessment.reason!);
      }

      if (!assessment.canAutoRecover && !options.acknowledgeUnknown) {
        throw new UserError(
          `Cannot auto-recover: ${assessment.reason}\n` +
            `Unguarded steps: ${unguardedSteps.join(", ")}\n` +
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
