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

/** The run-search fields that decide whether a run can be resumed. */
export interface ResumableRun {
  runId: string;
  workflowName: string;
  status: string;
  awaitingResume?: boolean;
  workflowHasInputs?: boolean;
}

export interface ResumeState {
  /** The CLI command that resumes the run, for anyone who cannot click. */
  command: string;
  /**
   * The workflow declares inputs, so the run may expect values supplied at
   * resume. A dashboard resume supplies none.
   */
  needsInputs: boolean;
}

/**
 * Whether a run is approved and waiting for a resume, and how to resume it.
 * Returns null for any run that is not suspended with every gate decided,
 * including one whose gate is still waiting or has timed out.
 */
export function resumeStateFor(run: ResumableRun): ResumeState | null {
  if (run.status !== "suspended" || !run.awaitingResume) return null;
  const command =
    `swamp workflow resume ${run.workflowName} --run ${run.runId}`;
  return run.workflowHasInputs
    ? { command: `${command} --input <key>=<value>`, needsInputs: true }
    : { command, needsInputs: false };
}

/** An entry in the health snapshot's active runs: a run serve drives now. */
export interface ActiveRunRef {
  runId: string;
}

/**
 * The runs serve is driving right now. A run in this set is already being
 * resumed (or run), so it is not offered for a resume, whoever approved it.
 * Empty without a health snapshot.
 */
export function activeRunIds(
  activeRuns: readonly ActiveRunRef[] | undefined,
): ReadonlySet<string> {
  return new Set((activeRuns ?? []).map((run) => run.runId));
}

/** A key that changes only when a run starts or stops being driven. */
export function activeRunsKey(
  activeRuns: readonly ActiveRunRef[] | undefined,
): string {
  return [...activeRunIds(activeRuns)].sort().join(",");
}

/**
 * Whether a health snapshot calls for a fresh run search: a run started or
 * stopped since `previousKey`, or a run serve drives still reads suspended in
 * `rows`. Serve registers a resume before it saves the run as running, so a
 * search right after the start can still see the run suspended.
 */
export function shouldRefetchRuns(
  previousKey: string,
  activeRuns: readonly ActiveRunRef[] | undefined,
  rows: readonly { runId: string; status: string }[],
): boolean {
  if (activeRunsKey(activeRuns) !== previousKey) return true;
  const active = activeRunIds(activeRuns);
  return rows.some((row) =>
    row.status === "suspended" && active.has(row.runId)
  );
}
