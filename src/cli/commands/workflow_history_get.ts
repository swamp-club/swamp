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
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import { createWorkflowHistoryGetRenderer } from "../../presentation/renderers/workflow_history_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowHistoryGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function workflowHistoryGetAction(
  options: AnyOptions,
  runIdOrWorkflow: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "history",
    "get",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowHistoryGetResponse>(
      { server, token },
      {
        type: "workflow.history.get",
        payload: { workflowIdOrName: runIdOrWorkflow },
      },
    );
    const renderer = createWorkflowHistoryGetRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as WorkflowRunView,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  cliCtx.logger.debug`Getting run for: ${runIdOrWorkflow}`;

  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createWorkflowHistoryGetDeps(
    repoDir,
    datastoreResolver,
    repoContext.workflowRepo,
  );

  const renderer = createWorkflowHistoryGetRenderer(cliCtx.outputMode);
  await consumeStream(
    workflowHistoryGet(ctx, deps, runIdOrWorkflow),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Workflow history get command completed");
}

export const workflowHistoryGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description("Show a specific run by ID or the latest run for a workflow")
    .example("Show latest run", "swamp workflow history get deploy-pipeline")
    .example("Show run by ID", "swamp workflow history get abc123")
    .arguments("<run_id_or_workflow:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(workflowHistoryGetAction);
