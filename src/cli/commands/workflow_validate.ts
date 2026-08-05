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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createWorkflowValidateDeps,
  workflowsDirFor,
  workflowValidate,
  type WorkflowValidateAllData,
  type WorkflowValidateData,
} from "../../libswamp/mod.ts";
import { createWorkflowValidateRenderer } from "../../presentation/renderers/workflow_validate.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowValidateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowValidateCommand = withRemoteOptions(
  new Command()
    .name("validate")
    .description("Validate a workflow against its schema")
    .example("Validate a workflow", "swamp workflow validate deploy-pipeline")
    .example("Validate all workflows", "swamp workflow validate")
    .arguments("[workflow_id_or_name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, workflowIdOrName?: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "validate",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowValidateResponse>(
      { server, token },
      {
        type: "workflow.validate",
        payload: { workflowIdOrName },
      },
    );
    const renderer = createWorkflowValidateRenderer(cliCtx.outputMode);
    renderer.handlers().completed({
      kind: "completed",
      data: response.data as unknown as
        | WorkflowValidateData
        | WorkflowValidateAllData,
    });
    return;
  }

  const { repoContext, repoDir } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  // Hot-load pulled/local extensions so step-input validation can resolve
  // their model types. Without this, pulled extension types are skipped as
  // "not resolved" and the step silently passes (parity with `type describe`
  // and `model validate`, which both call ensureLoaded before resolving).
  await modelRegistry.ensureLoaded();

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createWorkflowValidateDeps(
    repoContext.workflowRepo,
    repoContext.definitionRepo,
    workflowsDirFor(repoDir),
  );

  const renderer = createWorkflowValidateRenderer(cliCtx.outputMode);
  await consumeStream(
    workflowValidate(ctx, deps, { workflowIdOrName }),
    renderer.handlers(),
  );

  if (!renderer.passed()) {
    Deno.exit(1);
  }
});
