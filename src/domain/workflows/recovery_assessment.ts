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

import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";
import type { WorkflowRunRepository } from "./repositories.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";

export interface RecoveryAssessment {
  canAutoRecover: boolean;
  reason?: string;
  guardedSteps: string[];
  unguardedSteps: string[];
  runId?: string;
  workflowId?: string;
  fingerprintMismatch?: boolean;
}

export async function assessRecoveryForRun(
  workflow: Workflow,
  run: WorkflowRun,
): Promise<RecoveryAssessment> {
  let fingerprintMismatch = false;
  // Starting over is the only way forward from a refused run: resume --from
  // accepts failed runs, not interrupted ones (swamp-club#2443).
  const newRunHint =
    `start a new run with 'swamp workflow run ${workflow.name}'`;
  let mismatchReason =
    `Workflow definition changed since the run started — ${newRunHint}`;
  if (run.runPlan?.fingerprint) {
    const currentFingerprint = await computeWorkflowFingerprint(workflow);
    if (run.runPlan.definitionFingerprint !== undefined) {
      fingerprintMismatch =
        currentFingerprint !== run.runPlan.definitionFingerprint;
    } else if (currentFingerprint !== run.runPlan.fingerprint) {
      // Recorded before runs stored a definition fingerprint. The evaluated
      // fingerprint equals the definition's only when evaluation left the
      // definition unchanged, so a difference cannot tell drift from
      // evaluation. Refuse rather than resume a definition that may have
      // changed.
      fingerprintMismatch = true;
      mismatchReason =
        `Run was recorded before swamp stored definition fingerprints, so an unchanged workflow definition cannot be confirmed — ${newRunHint}`;
    }
  }

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

  return {
    canAutoRecover: !fingerprintMismatch && unguardedSteps.length === 0,
    reason: fingerprintMismatch
      ? mismatchReason
      : unguardedSteps.length > 0
      ? `${unguardedSteps.length} unknown step(s) lack guard expressions — operator acknowledgement required`
      : undefined,
    guardedSteps,
    unguardedSteps,
    runId: run.id,
    workflowId: workflow.id,
    fingerprintMismatch,
  };
}

export async function findInterruptedRun(
  workflow: Workflow,
  runRepo: WorkflowRunRepository,
  targetRunId?: string,
): Promise<WorkflowRun | null> {
  const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
  const interruptedRuns = allRuns.filter((r) => r.status === "interrupted");
  if (interruptedRuns.length === 0) return null;
  if (targetRunId) {
    return interruptedRuns.find((r) => r.id === targetRunId) ?? null;
  }
  if (interruptedRuns.length > 1) {
    interruptedRuns.sort((a, b) => {
      const aTime = a.startedAt?.getTime() ?? 0;
      const bTime = b.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }
  return interruptedRuns[0];
}
