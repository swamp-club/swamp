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
  if (run.runPlan?.fingerprint) {
    const currentFingerprint = await computeWorkflowFingerprint(workflow);
    if (currentFingerprint !== run.runPlan.fingerprint) {
      fingerprintMismatch = true;
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
