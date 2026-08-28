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
  consumeStream,
  createLibSwampContext,
  createWorkflowApprovalsDeps,
  type PendingApproval,
  workflowApprovals,
  type WorkflowApprovalsEvent,
} from "../../libswamp/mod.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import type { CommandContext } from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { checkUnmigratedNamespaceData } from "../resolve_datastore.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowApprovalsResponse } from "../../serve/protocol.ts";
import type { WorkflowRunId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";

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

export function renderApprovals(
  cliCtx: CommandContext,
  pending: PendingApproval[],
): void {
  if (cliCtx.outputMode === "json") {
    console.log(JSON.stringify({ approvals: pending }, null, 2));
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
        cliCtx.logger.info(
          "  swamp workflow approve {workflowName} {stepName} --run {runId}",
          {
            workflowName: item.workflowName,
            stepName: item.stepName,
            runId: item.runId,
          },
        );
        cliCtx.logger.info(
          "  swamp workflow reject  {workflowName} {stepName} --run {runId}",
          {
            workflowName: item.workflowName,
            stepName: item.stepName,
            runId: item.runId,
          },
        );
        cliCtx.logger.info(
          "  After approval: swamp workflow resume {workflowName} --run {runId}",
          { workflowName: item.workflowName, runId: item.runId },
        );
      }
    }
  }
}

export const workflowApprovalsCommand = withRemoteOptions(
  new Command()
    .name("approvals")
    .description("List all workflow runs awaiting manual approval")
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
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowApprovalsResponse>(
      { server, token },
      {
        type: "workflow.approvals",
        payload: {},
      },
    );
    const data = response.data as { approvals?: PendingApproval[] };
    renderApprovals(cliCtx, data.approvals ?? []);
    return;
  }

  const { repoDir, repoContext, datastoreConfig } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const runRepo = repoContext.workflowRunRepo;
  const evaluatedRepo = new YamlEvaluatedWorkflowRepository(repoDir);
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
  await consumeStream<WorkflowApprovalsEvent>(
    workflowApprovals(ctx, deps),
    {
      resolving: () => {},
      completed: (e) => {
        pending = e.data.approvals;
      },
      error: (e) => {
        throw new Error(e.error.message);
      },
    },
  );

  renderApprovals(cliCtx, pending);

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
