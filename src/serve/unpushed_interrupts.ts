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

/**
 * The checkout-local record of the workflow runs a `swamp serve` shutdown
 * interrupted but could not push (swamp-club#3958). The next serve in the
 * same checkout pushes once at boot while it is present, so the datastore
 * does not keep those runs `running` until some unrelated write pushes.
 *
 * The file sits beside `serve.pid` and the run tracker, which never sync.
 * Its run ids are only logged: whether it exists is what decides the push.
 */

import { atomicWriteTextFile } from "../infrastructure/persistence/atomic_write.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { isUuid } from "../domain/models/model_lookup.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../domain/workflows/workflow_id.ts";

const logger = getSwampLogger(["serve", "interrupts"]);

/** The marker's file name under the checkout's `.swamp` directory. */
export const UNPUSHED_INTERRUPTS_FILE = "serve-unpushed-interrupts.json";

/**
 * One run the marker names. The workflow id is kept when shutdown knew it,
 * so the next start can read the record by id: the status index does not
 * notice a pull that replaced a record with an older status.
 */
export interface UnpushedRun {
  readonly runId: string;
  readonly workflowId?: string;
}

/** What a marker read found. */
export type UnpushedInterrupts =
  | { readonly present: false }
  | { readonly present: true; readonly runs: readonly UnpushedRun[] };

/**
 * Reads the marker at `path`. A missing file is absent; a file that is not
 * a JSON object with a `runs` array of `{ runId, workflowId? }` strings is
 * logged and counted as present with no runs, so the next start still
 * pushes.
 */
export async function readUnpushedInterrupts(
  path: string,
): Promise<UnpushedInterrupts> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { present: false };
    throw error;
  }
  const runs = parseRuns(text);
  if (runs === undefined) {
    logger.warn(
      "The record of unpushed interrupted workflow runs at {path} is malformed; pushing anyway",
      { path },
    );
    return { present: true, runs: [] };
  }
  return { present: true, runs };
}

/**
 * Adds `runs` to the marker at `path`, keeping the runs already recorded.
 * The write is atomic, so a crash mid-write leaves the previous marker.
 */
export async function recordUnpushedInterrupts(
  path: string,
  runs: readonly UnpushedRun[],
): Promise<void> {
  const existing = await readUnpushedInterrupts(path);
  const merged = new Map<string, UnpushedRun>();
  for (const run of existing.present ? existing.runs : []) {
    merged.set(run.runId, run);
  }
  for (const { runId, workflowId: given } of runs) {
    const workflowId = given ?? merged.get(runId)?.workflowId;
    merged.set(
      runId,
      workflowId === undefined ? { runId } : { runId, workflowId },
    );
  }
  await atomicWriteTextFile(
    path,
    JSON.stringify({ runs: [...merged.values()] }) + "\n",
  );
}

/** Removes the marker at `path`; a missing marker is not an error. */
export async function clearUnpushedInterrupts(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * The runs `marker` names that are still `running` in the cache, read by id.
 * Serve's boot reap adds them to the runs it judges: a record a pull put
 * back to `running` is not in the status index under that status. Only ids
 * that are both UUIDs are read, since they name a file. A run that cannot be
 * read is left out.
 */
export async function markedRunsStillRunning(
  marker: UnpushedInterrupts,
  findById: (
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ) => Promise<WorkflowRun | null>,
): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
  if (!marker.present) return [];
  const found: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
  for (const { runId, workflowId } of marker.runs) {
    if (workflowId === undefined || !isUuid(workflowId) || !isUuid(runId)) {
      continue;
    }
    const id = createWorkflowId(workflowId);
    try {
      const run = await findById(id, createWorkflowRunId(runId));
      if (run?.status === "running") found.push({ run, workflowId: id });
    } catch (error) {
      logger.warn("Boot: could not read workflow run {runId}: {error}", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

function parseRuns(text: string): UnpushedRun[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const runs = (parsed as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return undefined;
  const result: UnpushedRun[] = [];
  for (const entry of runs) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { runId, workflowId } = entry as Record<string, unknown>;
    if (typeof runId !== "string") return undefined;
    if (workflowId !== undefined && typeof workflowId !== "string") {
      return undefined;
    }
    result.push(workflowId === undefined ? { runId } : { runId, workflowId });
  }
  return result;
}

/**
 * The push serve's boot reap makes as its root's flush: once, when the reap
 * interrupted a run or the previous shutdown left `marker`. A push that
 * fails is logged and keeps the marker for the next start; one that lands
 * clears it. Nothing is thrown, so boot goes on.
 */
export async function pushSettledAtBoot(options: {
  readonly reaped: number;
  readonly marker: UnpushedInterrupts;
  readonly markerPath: string;
  readonly push: () => Promise<void>;
}): Promise<void> {
  const { reaped, marker, markerPath } = options;
  if (reaped === 0 && !marker.present) return;
  try {
    await options.push();
  } catch (error) {
    logger.warn(
      marker.present
        ? "Boot: could not push the interrupted workflow runs to the datastore; the record of them is kept and the push retried at the next start: {error}"
        : "Boot: could not push the interrupted workflow runs to the datastore: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return;
  }
  if (!marker.present) return;
  logger.info(
    "Boot: pushed the interrupted workflow run(s) {runIds} the previous shutdown could not push",
    { runIds: marker.runs.map((r) => r.runId) },
  );
  try {
    await clearUnpushedInterrupts(markerPath);
  } catch (error) {
    logger.warn(
      "Boot: could not remove the record of unpushed interrupted workflow runs: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}
