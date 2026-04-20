// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  workflowValidate,
} from "../../libswamp/mod.ts";
import { createWorkflowValidateRenderer } from "../../presentation/renderers/workflow_validate.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowValidateCommand = new Command()
  .name("validate")
  .description("Validate a workflow against its schema")
  .example("Validate a workflow", "swamp workflow validate deploy-pipeline")
  .example("Validate all workflows", "swamp workflow validate")
  .arguments("[workflow_id_or_name:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "validate",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowValidateDeps(
      repoContext.workflowRepo,
      repoContext.definitionRepo,
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
