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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createWorkflowApprovalsDeps,
  type ExpiredApproval,
  type PendingApproval,
  workflowApprovals,
  type WorkflowApprovalsEvent,
} from "../../libswamp/workflows/approvals.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import type { CommandContext } from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { checkUnmigratedNamespaceData } from "../resolve_datastore.ts";
import {
  formatCommandTarget,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowApprovalsResponse } from "../../serve/protocol.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { escapeControlCharacters } from "../../domain/control_characters.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import type { WorkflowRunId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function formatInputsDigest(
  inputs: Readonly<Record<string, unknown>>,
): string | undefined {
  const keys = Object.keys(inputs);
  if (keys.length === 0) return undefined;
  const pairs = keys.sort().map((k) => {
    const v = inputs[k];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${s}`;
  });
  const digest = pairs.join(", ");
  return digest.length > 80 ? digest.slice(0, 77) + "..." : digest;
}

/**
 * The command that cancels a suspended run. A run a serve instance started
 * is refused by a local cancel, so it gets the `--server` form, with a
 * placeholder when no server was named.
 */
function cancelCommand(
  run: { workflowName: string; runId: string; serveStarted: boolean },
  target: string,
): string {
  if (target) return `swamp workflow cancel --run ${run.runId}${target}`;
  if (run.serveStarted) {
    return `swamp workflow cancel --run ${run.runId} --server <url>`;
  }
  return `swamp workflow cancel ${
    quoteShellWord(run.workflowName)
  } --run ${run.runId}`;
}

function renderExpired(
  cliCtx: CommandContext,
  expired: ExpiredApproval[],
  target: string,
): void {
  if (expired.length === 0) return;
  const quiet = cliCtx.verbosity === "quiet";
  cliCtx.logger.info(
    "Expired gates ({count}): past their timeout, so they can only be cancelled",
    { count: expired.length },
  );
  for (const item of expired) {
    cliCtx.logger.info(
      "{workflowName} / {stepName} — expired",
      { workflowName: item.workflowName, stepName: item.stepName },
    );
    cliCtx.logger.info("  Run:          {runId}", { runId: item.runId });
    cliCtx.logger.info(
      "  Suspended at: {suspendedAt}",
      { suspendedAt: item.suspendedAt },
    );
    cliCtx.logger.info(
      "  Expired at:   {expiredAt} (timeout {timeoutSeconds}s)",
      { expiredAt: item.expiredAt, timeoutSeconds: item.timeoutSeconds },
    );
    if (!quiet) writeOutput(`  ${cancelCommand(item, target)}`);
    if (item.parentRun) {
      if (item.parentWaiting === false) {
        cliCtx.logger.info(
          "  Nested run of {parentWorkflow} ({parentRunId}): the parent no longer waits on it",
          {
            parentWorkflow: item.parentRun.workflowName,
            parentRunId: item.parentRun.runId,
          },
        );
      } else if (!quiet) {
        writeOutput(
          `  Nested run of ${
            escapeControlCharacters(item.parentRun.workflowName)
          }: the parent stays suspended after this cancel; cancel it with ${
            cancelCommand(item.parentRun, target)
          }`,
        );
      }
    }
  }
}

export function renderApprovals(
  cliCtx: CommandContext,
  pending: PendingApproval[],
  expired: ExpiredApproval[] = [],
  server?: string,
): void {
  const target = formatCommandTarget({ server });
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify({ approvals: pending, expired }, null, 2));
  } else {
    if (pending.length === 0) {
      cliCtx.logger.info("No workflows awaiting approval");
    } else {
      for (const item of pending) {
        const inputsDigest = formatInputsDigest(item.inputs);
        cliCtx.logger.info(
          "{workflowName} / {stepName} — {prompt}",
          {
            workflowName: item.workflowName,
            stepName: item.stepName,
            prompt: item.prompt ?? "(no prompt)",
          },
        );
        cliCtx.logger.info(
          "  Run:          {runId}",
          { runId: item.runId },
        );
        if (item.suspendedAt) {
          cliCtx.logger.info(
            "  Suspended at: {suspendedAt}",
            { suspendedAt: item.suspendedAt },
          );
        }
        if (inputsDigest) {
          cliCtx.logger.info(
            "  Inputs:       {inputs}",
            { inputs: inputsDigest },
          );
        }
        // Commands go through writeOutput: LogTape quotes interpolated values
        // and the pretty sink wraps long lines, and either breaks a
        // copy-pasted command (swamp-club#2977). `--quiet` hides them, as it
        // hides the logger's info lines.
        // Step names are any non-empty string, so every name is
        // shell-quoted; --server carries over the explicit flag.
        const quiet = cliCtx.verbosity === "quiet";
        const workflow = quoteShellWord(item.workflowName);
        const step = quoteShellWord(item.stepName);
        if (!quiet) {
          writeOutput(
            `  swamp workflow approve ${workflow} ${step} --run ${item.runId}${target}`,
          );
          writeOutput(
            `  swamp workflow reject  ${workflow} ${step} --run ${item.runId}${target}`,
          );
          writeOutput(
            `  After approval: swamp workflow resume ${workflow} --run ${item.runId}${target}`,
          );
        }
        // A nested workflow's gate: its parent resumes after it
        // (swamp-club#2736).
        if (item.parentRun) {
          if (item.parentWaiting === false) {
            cliCtx.logger.info(
              "  Nested run of {parentWorkflow} ({parentRunId}): the parent no longer waits on it",
              {
                parentWorkflow: item.parentRun.workflowName,
                parentRunId: item.parentRun.runId,
              },
            );
          } else if (!quiet) {
            writeOutput(
              `  Nested run of ${
                escapeControlCharacters(item.parentRun.workflowName)
              }: once this run finishes, swamp workflow resume ${
                quoteShellWord(item.parentRun.workflowName)
              } --run ${item.parentRun.runId}${target}`,
            );
          }
        }
      }
    }
    renderExpired(cliCtx, expired, target);
  }
}

export const workflowApprovalsCommand = withRemoteOptions(
  new Command()
    .name("approvals")
    .description(
      "List all workflow runs awaiting manual approval, and gates that expired",
    )
    .example("List pending approvals", "swamp workflow approvals")
    .example(
      "List via server",
      "swamp workflow approvals --server ws://localhost:9090",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "approvals",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<WorkflowApprovalsResponse>(
      { server, token },
      {
        type: "workflow.approvals",
        payload: {},
      },
    );
    // An older serve sends no expired list.
    const data = response.data as {
      approvals?: PendingApproval[];
      expired?: ExpiredApproval[];
    };
    renderApprovals(
      cliCtx,
      data.approvals ?? [],
      data.expired ?? [],
      options.server as string | undefined,
    );
    return;
  }

  const { repoDir, repoContext, datastoreConfig, datastoreResolver } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const runRepo = repoContext.workflowRunRepo;
  const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
    repoDir,
    datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
  );
  const deps = createWorkflowApprovalsDeps(
    repoContext.workflowRepo,
    runRepo,
    async (workflowId) => {
      const suspended = await runRepo
        .findSummariesByStatus(workflowId, "suspended");
      const runs = await Promise.all(
        suspended.map((s) =>
          runRepo.findById(workflowId, s.id as WorkflowRunId)
        ),
      );
      return runs.filter((r): r is WorkflowRun => r !== null);
    },
    (workflowId) => evaluatedRepo.findById(workflowId),
  );

  let pending: PendingApproval[] = [];
  let expired: ExpiredApproval[] = [];
  await consumeStream<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
    {
      resolving: () => {},
      completed: (e) => {
        pending = e.data.approvals;
        expired = e.data.expired;
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    },
  );

  renderApprovals(cliCtx, pending, expired);

  if (pending.length === 0) {
    const unmigrated = await checkUnmigratedNamespaceData(datastoreConfig);
    if (unmigrated.length > 0) {
      cliCtx.logger.warn(
        "Un-migrated data found at root level ({dirs}). " +
          "Run 'swamp datastore namespace migrate' to preview, " +
          'then --confirm to move data under the "{namespace}" namespace.',
        { dirs: unmigrated.join(", "), namespace: datastoreConfig.namespace },
      );
    }
  }
});
