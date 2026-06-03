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

import type { TreeState } from "./state.ts";

/** Degradation tiers, from richest to most compact. */
export type Tier =
  | "full"
  | "no_peek"
  | "compressed_waiting"
  | "compressed_steps"
  | "one_line";

/** Default number of peek lines shown per active step (budget permitting). */
export const DEFAULT_PEEK_LINES = 3;

/** Lines reserved for breathing room around the active zone. */
const BREATHING_ROOM = 2;

/** Active zone never exceeds this fraction of terminal height. */
const MAX_HEIGHT_FRACTION = 0.5;

/** 1 line reserved for the separator between scrollback and active zone. */
const SEPARATOR_LINES = 1;

export interface BudgetResult {
  tier: Tier;
  /** Number of peek lines per step (0 if not full tier). */
  peekLines: number;
  /** Whether to show individual waiting/blocked jobs. */
  showWaitingList: boolean;
  /** Whether to expand parallel steps into sub-lines. */
  expandSteps: boolean;
  /** Max running jobs to show before collapsing to "… N more running". */
  maxVisibleRunning: number;
}

export interface BudgetInput {
  runningJobCount: number;
  /** Total number of active (running) steps across all running jobs. */
  activeStepCount: number;
  waitingJobCount: number;
}

/**
 * Extracts the counts needed for budget calculation from tree state.
 */
export function extractBudgetInput(state: TreeState): BudgetInput {
  let runningJobCount = 0;
  let activeStepCount = 0;
  let waitingJobCount = 0;

  for (const job of state.jobs.values()) {
    switch (job.status) {
      case "running":
        runningJobCount++;
        for (const step of job.steps.values()) {
          if (step.status === "running") activeStepCount++;
        }
        break;
      case "waiting":
      case "blocked":
        waitingJobCount++;
        break;
    }
  }

  return { runningJobCount, activeStepCount, waitingJobCount };
}

/**
 * Computes the appropriate display tier given terminal height and active zone
 * metrics. The active zone is capped at 50% of terminal height to prevent
 * rendering chaos on large workflows. Pure function — no side effects.
 */
export function computeTier(
  terminalHeight: number,
  input: BudgetInput,
): BudgetResult {
  const rawAvailable = Math.max(0, terminalHeight - BREATHING_ROOM);
  const halfScreen = Math.floor(terminalHeight * MAX_HEIGHT_FRACTION);
  // Cap at 50% of terminal, minus separator line
  const available = Math.max(
    0,
    Math.min(rawAvailable, halfScreen) - SEPARATOR_LINES,
  );

  const { runningJobCount, activeStepCount, waitingJobCount } = input;

  // Expanded steps: for jobs with >1 active step, each step gets a sub-line.
  // The job line itself counts as 1, plus (activeSteps - 1) extra for sub-lines.
  // For simplicity, we count running jobs + extra active steps.
  const expandedStepLines = activeStepCount > runningJobCount
    ? activeStepCount - runningJobCount
    : 0;

  const peekLinesTotal = activeStepCount * DEFAULT_PEEK_LINES;

  // Full: running jobs + expanded step sub-lines + peek lines + waiting jobs
  const fullLines = runningJobCount + expandedStepLines + peekLinesTotal +
    waitingJobCount;
  if (fullLines <= available && available > 0) {
    return {
      tier: "full",
      peekLines: DEFAULT_PEEK_LINES,
      showWaitingList: true,
      expandSteps: true,
      maxVisibleRunning: runningJobCount,
    };
  }

  // No peek: running jobs + expanded step sub-lines + waiting jobs
  const noPeekLines = runningJobCount + expandedStepLines + waitingJobCount;
  if (noPeekLines <= available && available > 0) {
    return {
      tier: "no_peek",
      peekLines: 0,
      showWaitingList: true,
      expandSteps: true,
      maxVisibleRunning: runningJobCount,
    };
  }

  // Compressed waiting: running jobs + expanded step sub-lines + 1 summary line
  const compressedWaitingLines = runningJobCount + expandedStepLines +
    (waitingJobCount > 0 ? 1 : 0);
  if (compressedWaitingLines <= available && available > 0) {
    return {
      tier: "compressed_waiting",
      peekLines: 0,
      showWaitingList: false,
      expandSteps: true,
      maxVisibleRunning: runningJobCount,
    };
  }

  // Compressed steps: one line per running job + 1 summary for waiting
  // If running jobs still exceed available, cap the visible count.
  const waitingSummaryLines = waitingJobCount > 0 ? 1 : 0;
  const compressedStepsLines = runningJobCount + waitingSummaryLines;
  if (compressedStepsLines <= available && available > 0) {
    return {
      tier: "compressed_steps",
      peekLines: 0,
      showWaitingList: false,
      expandSteps: false,
      maxVisibleRunning: runningJobCount,
    };
  }

  // Compressed steps with capped running jobs: show as many as fit
  // Reserve 1 line for waiting summary + 1 line for "… N more running"
  if (available >= 2) {
    const reservedLines = waitingSummaryLines +
      (runningJobCount > available - waitingSummaryLines ? 1 : 0);
    const maxVisible = Math.max(1, available - reservedLines);
    return {
      tier: "compressed_steps",
      peekLines: 0,
      showWaitingList: false,
      expandSteps: false,
      maxVisibleRunning: Math.min(runningJobCount, maxVisible),
    };
  }

  // One line: extreme fallback
  return {
    tier: "one_line",
    peekLines: 0,
    showWaitingList: false,
    expandSteps: false,
    maxVisibleRunning: 0,
  };
}
