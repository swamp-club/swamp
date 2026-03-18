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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  DefaultWorkflowValidationService,
} from "../../domain/workflows/validation_service.ts";
import {
  consumeStream,
  createLibSwampContext,
  workflowValidate,
} from "../../libswamp/mod.ts";
import { createWorkflowValidateRenderer } from "../../presentation/renderers/workflow_validate.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowValidateCommand = new Command()
  .name("validate")
  .description("Validate a workflow against its schema")
  .arguments("[workflow_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "validate",
    ]);
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const repo = repoContext.workflowRepo;
    const validationService = new DefaultWorkflowValidationService();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      findWorkflowById: (id: string) => repo.findById(createWorkflowId(id)),
      findWorkflowByName: (name: string) => repo.findByName(name),
      findAllWorkflows: () => repo.findAll(),
      validate: (workflow: Workflow) => validationService.validate(workflow),
    };

    const renderer = createWorkflowValidateRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowValidate(ctx, deps, { workflowIdOrName }),
      renderer.handlers(),
    );

    if (!renderer.passed()) {
      Deno.exit(1);
    }
  });
