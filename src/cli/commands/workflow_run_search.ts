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
  type JobRunView,
  parseTags,
  type StepRunView,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchItem,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import { renderWorkflowRunDisplay } from "../../presentation/renderers/workflow_run_display.ts";
import { createWorkflowRunSearchRenderer } from "../../presentation/renderers/workflow_run_search.tsx";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a WorkflowRun to WorkflowRunData for presentation.
 */
function toRunData(run: WorkflowRun, path?: string): WorkflowRunView {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job): JobRunView => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunView => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          const stepData: StepRunView = {
            name: step.stepName,
            status: step.status,
            error: step.error,
            duration: stepStart && stepEnd ? stepEnd - stepStart : undefined,
          };
          if (step.allowedFailure) {
            stepData.allowedFailure = true;
          }
          return stepData;
        }),
        duration: jobStart && jobEnd ? jobEnd - jobStart : undefined,
      };
    }),
    duration: startTime && endTime ? endTime - startTime : undefined,
    path,
  };
}

/**
 * Creates a fetchPreview closure that fetches full workflow run detail data.
 * This bridges the presentation layer to the run repository, converting
 * WorkflowRun to WorkflowRunView.
 */
function createRunFetchPreview(
  runRepo: YamlWorkflowRunRepository,
): (item: WorkflowRunSearchItem) => Promise<WorkflowRunView> {
  return async (item: WorkflowRunSearchItem): Promise<WorkflowRunView> => {
    const run = await runRepo.findById(
      createWorkflowId(item.workflowId),
      createWorkflowRunId(item.runId),
    );
    if (!run) {
      throw new Error(`Run not found: ${item.runId}`);
    }
    const path = runRepo.getPath(
      createWorkflowId(item.workflowId),
      createWorkflowRunId(item.runId),
    );
    return toRunData(run, path);
  };
}

export async function workflowRunSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(
    options as GlobalOptions,
    ["workflow", "run", "search"],
  );
  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching workflow runs with query: ${query ?? "(none)"}`;

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: effectiveMode,
  });
  const workflowRepo = repoContext.workflowRepo;
  const runRepo = repoContext.workflowRunRepo;

  // Parse --tag values into Record<string, string>
  const parsedTags = options.tag
    ? parseTags(options.tag as string[])
    : undefined;

  const deps: WorkflowRunSearchDeps = {
    findAllWorkflows: () => workflowRepo.findAll(),
    findAllRunsByWorkflowId: (id) =>
      runRepo.findAllByWorkflowId(createWorkflowId(id)),
  };

  const fetchPreview = effectiveMode === "log"
    ? createRunFetchPreview(runRepo)
    : undefined;

  const renderer = createWorkflowRunSearchRenderer(
    effectiveMode,
    fetchPreview,
  );
  await consumeStream(
    workflowRunSearch(libCtx, deps, {
      query,
      since: options.since as string | undefined,
      status: options.status as string | undefined,
      workflow: options.workflow as string | undefined,
      tags: parsedTags,
      limit: options.limit as number | undefined,
    }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected run: ${selected.runId}`;
    // In JSON mode, still display the full run details after auto-select
    if (effectiveMode === "json") {
      const run = await runRepo.findById(
        createWorkflowId(selected.workflowId),
        createWorkflowRunId(selected.runId),
      );
      if (run) {
        const path = runRepo.getPath(
          createWorkflowId(selected.workflowId),
          createWorkflowRunId(selected.runId),
        );
        const runData = toRunData(run, path);
        renderWorkflowRunDisplay(runData, effectiveMode);
      }
    }
    // In interactive mode, the scrollback from the picker already contains
    // the run detail, so no additional findById+render call is needed.
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Workflow run search command completed");
}

export const workflowRunSearchCommand = new Command()
  .name("search")
  .description("Search workflow run history")
  .example("Browse all runs", "swamp workflow run search")
  .example("Search runs", "swamp workflow run search deploy")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--since <duration:string>",
    "Only runs started within duration (1h, 1d, 7d, 1w, 1mo)",
  )
  .option(
    "--status <status:string>",
    "Filter by run status (pending, running, succeeded, failed)",
  )
  .option(
    "--workflow <name:string>",
    "Filter by workflow name",
  )
  .option(
    "--tag <tag:string>",
    "Filter by tag (KEY=VALUE), can be repeated",
    { collect: true },
  )
  .option("--limit <n:number>", "Max results", { default: 50 })
  .action(workflowRunSearchAction);
