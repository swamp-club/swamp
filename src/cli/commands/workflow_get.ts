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
import { consumeStream } from "../../libswamp/mod.ts";
import { isUuid, workflowGet } from "../../libswamp/workflows/get.ts";
import type { WorkflowGetDeps } from "../../libswamp/workflows/get.ts";
import { createWorkflowGetRenderer } from "../../presentation/renderers/workflow_get.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowGetCommand = new Command()
  .name("get")
  .description("Show details of a workflow")
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
    const repo = repoContext.workflowRepo;

    const deps: WorkflowGetDeps = {
      findWorkflow: async (idOrName) => {
        if (isUuid(idOrName)) {
          return await repo.findById(createWorkflowId(idOrName));
        }
        return await repo.findByName(idOrName);
      },
      getWorkflowPath: (id) => repo.getPath(id),
    };

    const renderer = createWorkflowGetRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowGet(deps, workflowIdOrName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow get command completed");
  });
