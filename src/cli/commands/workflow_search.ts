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
  type WorkflowGetData,
  workflowSearch,
  type WorkflowSearchDeps,
} from "../../libswamp/mod.ts";
import {
  createWorkflowSearchRenderer,
  type WorkflowPreviewDetail,
  type WorkflowPreviewFetcher,
} from "../../presentation/renderers/workflow_search.tsx";
import { renderWorkflowGet } from "../../presentation/renderers/workflow_get.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Creates a fetchPreview closure that reads the workflow YAML file from disk.
 */
function createWorkflowFetchPreview(
  repo: WorkflowRepository,
): WorkflowPreviewFetcher {
  return async (
    item,
  ): Promise<WorkflowPreviewDetail> => {
    const workflow = await repo.findByName(item.name);
    if (!workflow) {
      throw new Error(`Workflow not found: ${item.name}`);
    }
    const path = repo.getPath(workflow.id);
    const yaml = await Deno.readTextFile(path);
    return { yaml, name: workflow.name };
  };
}

/**
 * Displays the workflow get output for JSON mode.
 */
async function displayWorkflowGet(
  name: string,
  repo: WorkflowRepository,
  outputMode: "json" | "log",
): Promise<void> {
  const workflow = await repo.findByName(name);
  if (!workflow) {
    throw new UserError(`Workflow not found: ${name}`);
  }

  const data: WorkflowGetData = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    version: workflow.version,
    jobs: workflow.jobs.map((job) => ({
      name: job.name,
      description: job.description,
      steps: job.steps.map((step) => ({
        name: step.name,
        description: step.description,
        task: step.task.toData(),
      })),
    })),
    path: repo.getPath(workflow.id),
  };

  renderWorkflowGet(data, outputMode);
}

export const workflowSearchCommand = new Command()
  .name("search")
  .description("Search for workflows")
  .example("Browse all workflows", "swamp workflow search")
  .example("Search by keyword", "swamp workflow search deploy")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching workflows with query: ${query ?? "(none)"}`;

    // Search is always read-only. Execution (if "r" is pressed) happens via
    // subprocess, so we don't need a write lock.
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: effectiveMode,
    });
    const repo = repoContext.workflowRepo;

    const deps: WorkflowSearchDeps = {
      findAllWorkflows: () => repo.findAll(),
    };

    const fetchPreview = effectiveMode === "log"
      ? createWorkflowFetchPreview(repo)
      : undefined;

    const renderer = createWorkflowSearchRenderer(effectiveMode, fetchPreview);
    await consumeStream(
      workflowSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();

    if (selected) {
      ctx.logger.debug`Selected workflow: ${selected.name}`;
      const action = renderer.selectedAction();

      if (action === "run") {
        // Shell out to `swamp workflow run <name>`, inheriting stdin/stdout/stderr
        // so the user gets the full interactive experience (input file selection,
        // progress tree, etc.)
        ctx.logger.debug`Running workflow: ${selected.name}`;
        const repoDir = resolveRepoDir(options.repoDir);
        const cmd = new Deno.Command(Deno.execPath(), {
          args: ["workflow", "run", selected.name, "--repo-dir", repoDir],
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        const status = await cmd.output();
        if (!status.success) {
          Deno.exit(status.code);
        }
      } else if (effectiveMode === "json") {
        // JSON mode: display workflow details
        await displayWorkflowGet(selected.name, repo, effectiveMode);
      }
      // Interactive mode without "run": scrollback already has the YAML
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Workflow search command completed");
  });
