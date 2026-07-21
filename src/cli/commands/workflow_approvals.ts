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
import {
  createFilesystemDetectDeps,
  detectUnmigratedNamespaceData,
  formatUnmigratedWarning,
} from "../../libswamp/datastores/namespace_migration_check.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowApprovalsResponse } from "../../serve/protocol.ts";
import type { WorkflowRunId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function renderApprovals(
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
        cliCtx.logger.info(
          "{workflowName} / {stepName} — {prompt}",
          {
            workflowName: item.workflowName,
            stepName: item.stepName,
            prompt: item.prompt ?? "(no prompt)",
          },
        );
        cliCtx.logger.info(
          "  swamp workflow approve {workflowName} {stepName}",
          { workflowName: item.workflowName, stepName: item.stepName },
        );
        cliCtx.logger.info(
          "  swamp workflow reject  {workflowName} {stepName}",
          { workflowName: item.workflowName, stepName: item.stepName },
        );
        cliCtx.logger.info(
          "  After approval: swamp workflow resume {workflowName}",
          { workflowName: item.workflowName },
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

  const { repoContext, datastoreResolver } =
    await requireInitializedRepoUnlocked({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const runRepo = repoContext.workflowRunRepo;
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
    const dsConfig = datastoreResolver.config();
    if (dsConfig.namespace) {
      const dsBasePath = isCustomDatastoreConfig(dsConfig)
        ? (dsConfig.cachePath ?? dsConfig.datastorePath)
        : dsConfig.path;
      const unmigrated = await detectUnmigratedNamespaceData(
        dsBasePath,
        dsConfig.namespace,
        createFilesystemDetectDeps(),
      );
      if (unmigrated.length > 0) {
        cliCtx.logger.warn(formatUnmigratedWarning(unmigrated));
      }
    }
  }
});
