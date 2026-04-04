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
  consumeStream,
  createLibSwampContext,
  createWorkflowGetDeps,
  workflowGet,
} from "../../libswamp/mod.ts";
import { createWorkflowGetRenderer } from "../../presentation/renderers/workflow_get.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowGetCommand = new Command()
  .name("get")
  .description("Show details of a workflow")
  .example("Show workflow details", "swamp workflow get deploy-pipeline")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, ["workflow", "get"]);
    cliCtx.logger.debug`Getting workflow: ${workflowIdOrName}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowGetDeps(repoContext.workflowRepo);

    const renderer = createWorkflowGetRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowGet(ctx, deps, workflowIdOrName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow get command completed");
  });
