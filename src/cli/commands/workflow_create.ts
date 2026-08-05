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
  createWorkflowCreateDeps,
  workflowCreate,
  type WorkflowCreateData,
} from "../../libswamp/mod.ts";
import { createWorkflowCreateRenderer } from "../../presentation/renderers/workflow_create.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowCreateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowCreateCommand = withRemoteOptions(
  new Command()
    .description("Create a new workflow")
    .example("Create a workflow", "swamp workflow create deploy-pipeline")
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "create",
  ]);
  cliCtx.logger.debug`Creating workflow: name=${name}`;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowCreateResponse>(
      { server, token },
      { type: "workflow.create", payload: { name } },
    );
    const renderer = createWorkflowCreateRenderer(cliCtx.outputMode);
    renderer.handlers().completed({
      kind: "completed",
      data: response.data as unknown as WorkflowCreateData,
    });
    return;
  }

  const { repoDir } = await requireInitializedRepoUnlocked({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createWorkflowCreateDeps(repoDir);
  const renderer = createWorkflowCreateRenderer(cliCtx.outputMode);
  await consumeStream(
    workflowCreate(ctx, deps, { name }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Workflow create command completed");
});
