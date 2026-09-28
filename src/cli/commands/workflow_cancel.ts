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
  normalizeServerUrl,
  redactServerUrl,
} from "../../domain/auth/server_url.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { killProcessTree } from "../../infrastructure/process/process_kill.ts";
import {
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { RUN_CANCEL_GRACE_MS } from "../../serve/suspended_run_cancel.ts";
import { GATE_WAIT_TIMEOUT_MS } from "../../serve/sync_gate.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Builds the serve cancel endpoint URL from the --server value. Starts from
 * the normalized http(s) URL, so userinfo, query string and fragment never
 * reach the request URL or its error text.
 */
export function buildCancelUrl(server: string, runId: string): string {
  let base: string;
  try {
    base = normalizeServerUrl(server);
  } catch {
    const shown = redactServerUrl(server);
    throw new UserError(
      `Invalid --server URL${
        shown === undefined ? "" : ` '${shown}'`
      } — expected ws://host:port (or http://)`,
    );
  }
  return `${base}/api/v1/cancel/workflow-run/${encodeURIComponent(runId)}`;
}

/**
 * How long `--server` waits for the cancel endpoint to answer. Cancelling a
 * run serve is driving waits up to {@link RUN_CANCEL_GRACE_MS} for it to stop,
 * then may wait for the sync gate (up to {@link GATE_WAIT_TIMEOUT_MS}) to
 * cancel a run the resume left suspended, then pushes. The margin covers the
 * suspended-run lookup and the push.
 */
export const SERVER_CANCEL_TIMEOUT_MS = RUN_CANCEL_GRACE_MS +
  GATE_WAIT_TIMEOUT_MS + 30_000;

/**
 * The error for a `--server` cancel request that got no answer. A timeout
 * says the cancel may still complete, because the server keeps working on it
 * after the client stops waiting.
 */
export function serverCancelFailure(
  server: string,
  runId: string,
  error: unknown,
): UserError {
  const shown = redactServerUrl(server) ?? "(invalid URL)";
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new UserError(
      `No answer from ${shown} within ${
        SERVER_CANCEL_TIMEOUT_MS / 1000
      }s. The cancel may still complete on the server; check it with 'swamp workflow history get ${runId} --server ${shown}'.`,
    );
  }
  return new UserError(
    `Could not connect to ${shown}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

export function isServeOwnedRun(run: WorkflowRun): boolean {
  return run.instanceId !== undefined;
}

export interface CancelLocalRunDeps {
  runRepo: Pick<WorkflowRunRepository, "findById" | "save">;
  killProcess?: (pid: number) => Promise<boolean>;
}

/**
 * Cancels a locally-owned run. Stops the owning process first, then re-reads
 * the run: the owner saves its own final record while handling SIGTERM, and
 * saving the pre-kill snapshot would overwrite it. A run the owner already
 * finished keeps its record (a cancelled one gets this reason); a run that is
 * still active is cancelled. Returns the persisted run, or null when the
 * record no longer exists.
 */
export async function cancelLocalRun(
  run: WorkflowRun,
  workflowId: WorkflowId,
  reason: string,
  { runRepo, killProcess = killProcessTree }: CancelLocalRunDeps,
): Promise<WorkflowRun | null> {
  if (run.pid && run.pid !== Deno.pid) {
    await killProcess(run.pid);
  }
  const current = await runRepo.findById(workflowId, run.id);
  if (!current) {
    return null;
  }
  if (!TERMINAL_STATUSES.has(current.status)) {
    current.cancel(reason);
  } else if (current.status === "cancelled") {
    current.recordCancelReason(reason);
  } else {
    return current;
  }
  await runRepo.save(workflowId, current);
  return current;
}

export interface CancelAllResult {
  cancelled: { runId: string; workflowName: string; previousStatus: string }[];
  /** Runs that reached another terminal status before the cancel landed. */
  finished: {
    runId: string;
    workflowName: string;
    previousStatus: string;
    status: string;
  }[];
  /** Runs whose record was deleted during the cancel. */
  deleted: { runId: string; workflowName: string }[];
}

/**
 * Cancels each locally-owned run with {@link cancelLocalRun} and sorts the
 * outcomes, so only runs that actually ended cancelled count as cancelled.
 */
export async function cancelAllLocalRuns(
  runs: { run: WorkflowRun; workflowId: WorkflowId; workflowName: string }[],
  reason: string,
  deps: CancelLocalRunDeps,
): Promise<CancelAllResult> {
  const result: CancelAllResult = { cancelled: [], finished: [], deleted: [] };
  for (const { run, workflowId, workflowName } of runs) {
    const previousStatus = run.status;
    const finalRun = await cancelLocalRun(run, workflowId, reason, deps);
    if (!finalRun) {
      result.deleted.push({ runId: run.id, workflowName });
    } else if (finalRun.status === "cancelled") {
      result.cancelled.push({ runId: run.id, workflowName, previousStatus });
    } else {
      result.finished.push({
        runId: run.id,
        workflowName,
        previousStatus,
        status: finalRun.status,
      });
    }
  }
  return result;
}

async function findAllActiveRuns(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): Promise<
  { run: WorkflowRun; workflowId: WorkflowId; workflowName: string }[]
> {
  const workflows = await workflowRepo.findAll();
  const results: {
    run: WorkflowRun;
    workflowId: WorkflowId;
    workflowName: string;
  }[] = [];

  for (const workflow of workflows) {
    const runs = await runRepo.findAllByWorkflowId(workflow.id);
    for (const run of runs) {
      if (!TERMINAL_STATUSES.has(run.status)) {
        results.push({
          run,
          workflowId: workflow.id,
          workflowName: workflow.name,
        });
      }
    }
  }
  return results;
}

export const workflowCancelCommand = withRemoteOptions(
  new Command()
    .name("cancel")
    .description("Cancel a running workflow run")
    .example(
      "Cancel latest running run",
      "swamp workflow cancel my-workflow",
    )
    .example(
      "Cancel a specific run",
      "swamp workflow cancel my-workflow --run <run-id>",
    )
    .example(
      "Cancel all running runs",
      "swamp workflow cancel --all",
    )
    .example(
      "Cancel with reason",
      "swamp workflow cancel my-workflow --reason 'No longer needed'",
    )
    .example(
      "Cancel via server",
      "swamp workflow cancel --run <run-id> --server ws://localhost:9090",
    )
    .arguments("[workflow_id_or_name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--run <run_id:string>",
      "Target a specific run ID (required with --server)",
    )
    .option("--all", "Cancel all running workflow runs")
    .option("--reason <reason:string>", "Reason for cancellation"),
).action(
  async function (
    options: AnyOptions,
    workflowIdOrName?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "cancel",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      if (!options.run) {
        throw new UserError(
          "Remote cancel requires --run <run-id>. Use 'swamp workflow history search --server' to find run IDs.",
        );
      }
      if (options.all) {
        throw new UserError(
          "--all is not supported with --server",
        );
      }
      if (options.reason) {
        cliCtx.logger
          .warn`--reason is ignored with --server (the cancel endpoint does not accept a reason)`;
      }
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const cancelUrl = buildCancelUrl(server, options.run as string);
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      let body: Record<string, unknown>;
      try {
        const response = await fetch(cancelUrl, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(SERVER_CANCEL_TIMEOUT_MS),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new UserError(
            `Server returned ${response.status}: ${
              text || response.statusText
            }`,
          );
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw serverCancelFailure(server, options.run as string, error);
      }
      if (
        body.status !== "cancelled" &&
        body.status !== "cancellation_requested"
      ) {
        throw new UserError(
          (body.message as string | undefined) ??
            `Failed to cancel run ${options.run as string}: ${body.status}`,
        );
      }
      const runId = options.run as string;
      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          runId: body.executionId ?? runId,
          status: body.status,
          reason: options.reason ?? "Cancelled by user",
        }));
      } else if (body.status === "cancelled") {
        cliCtx.logger.info`Cancelled run ${runId} on server`;
      } else {
        cliCtx.logger
          .warn`Cancellation requested for run ${runId} on server (run may still be active — check health endpoint to confirm)`;
      }
      return;
    }

    if (!options.all && !workflowIdOrName) {
      throw new UserError(
        "Provide a workflow name or ID, or use --all to cancel all running runs",
      );
    }

    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;
    const reason = options.reason ?? "Cancelled by user";

    if (options.all) {
      const activeRuns = await findAllActiveRuns(workflowRepo, runRepo);
      if (activeRuns.length === 0) {
        if (cliCtx.outputMode === "json") {
          console.log(
            JSON.stringify({
              cancelled: [],
              finished: [],
              deleted: [],
              skipped: [],
            }),
          );
        } else {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
        return;
      }

      const localRuns = activeRuns.filter(({ run }) => !isServeOwnedRun(run));
      const serveRuns = activeRuns.filter(({ run }) => isServeOwnedRun(run));

      const { cancelled, finished, deleted } = await cancelAllLocalRuns(
        localRuns,
        reason,
        { runRepo },
      );

      const serveSkipped = serveRuns.map(({ run, workflowName }) => ({
        runId: run.id,
        workflowName,
        status: run.status,
      }));

      if (cliCtx.outputMode === "json") {
        console.log(JSON.stringify({
          cancelled,
          finished,
          deleted,
          skipped: serveSkipped,
          count: cancelled.length,
          reason,
        }));
      } else {
        if (cancelled.length > 0) {
          cliCtx.logger
            .info`Cancelled ${cancelled.length} workflow run(s)`;
          for (const entry of cancelled) {
            cliCtx.logger
              .info`  ${entry.workflowName} (${entry.runId}): ${entry.previousStatus} -> cancelled`;
          }
        }
        if (finished.length > 0) {
          cliCtx.logger
            .warn`${finished.length} run(s) finished before the cancel took effect`;
          for (const entry of finished) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId}): ${entry.previousStatus} -> ${entry.status}`;
          }
        }
        if (deleted.length > 0) {
          cliCtx.logger
            .warn`Skipped ${deleted.length} run(s) whose record no longer exists`;
          for (const entry of deleted) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId})`;
          }
        }
        if (serveSkipped.length > 0) {
          cliCtx.logger
            .warn`Skipped ${serveSkipped.length} serve-owned run(s) — cancel these individually via --server --run <id>`;
          for (const entry of serveSkipped) {
            cliCtx.logger
              .warn`  ${entry.workflowName} (${entry.runId}): ${entry.status}`;
          }
        }
        if (
          cancelled.length === 0 && finished.length === 0 &&
          deleted.length === 0 && serveSkipped.length === 0
        ) {
          cliCtx.logger.info("No active workflow runs found to cancel.");
        }
      }
      return;
    }

    // Single workflow cancel path
    const workflow = await workflowRepo.findByName(workflowIdOrName!) ??
      await workflowRepo.findById(
        createWorkflowId(workflowIdOrName!),
      );
    if (!workflow) {
      throw new UserError(`Workflow not found: ${workflowIdOrName}`);
    }

    let run: WorkflowRun;
    if (options.run) {
      const found = await runRepo.findById(
        workflow.id,
        createWorkflowRunId(options.run),
      );
      if (!found) {
        throw new UserError(`Workflow run not found: ${options.run}`);
      }
      run = found;
    } else {
      const allRuns = await runRepo.findAllByWorkflowId(workflow.id);
      const activeRuns = allRuns.filter(
        (r) => !TERMINAL_STATUSES.has(r.status),
      );

      if (activeRuns.length === 0) {
        throw new UserError(
          `No active runs found for workflow "${workflow.name}"`,
        );
      }

      run = activeRuns.reduce((latest, current) => {
        if (!latest.startedAt) return current;
        if (!current.startedAt) return latest;
        return current.startedAt > latest.startedAt ? current : latest;
      });
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new UserError(
        `Run ${run.id} is already in a terminal state (status: ${run.status})`,
      );
    }

    if (isServeOwnedRun(run)) {
      throw new UserError(
        `Run ${run.id} belongs to a serve instance and cannot be cancelled locally. ` +
          `Use --server to cancel it: swamp workflow cancel --run ${run.id} --server <url>`,
      );
    }

    const previousStatus = run.status;
    const finalRun = await cancelLocalRun(
      run,
      createWorkflowId(workflow.id),
      reason,
      { runRepo },
    );
    if (!finalRun) {
      throw new UserError(`Workflow run no longer exists: ${run.id}`);
    }
    const status = finalRun.status;

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify({
        runId: run.id,
        workflowName: workflow.name,
        previousStatus,
        status,
        ...(status === "cancelled" ? { reason } : {}),
      }));
    } else {
      if (status === "cancelled") {
        cliCtx.logger
          .info`Cancelled run ${run.id} of workflow ${workflow.name}`;
      } else {
        cliCtx.logger
          .warn`Run ${run.id} of workflow ${workflow.name} finished as ${status} before the cancel took effect`;
      }
      cliCtx.logger
        .info`Status: ${previousStatus} -> ${status}`;
      if (options.reason && status === "cancelled") {
        cliCtx.logger.info`Reason: ${reason}`;
      }
    }
  },
);
