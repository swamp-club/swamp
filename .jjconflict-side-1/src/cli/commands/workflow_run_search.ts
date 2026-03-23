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
  type JobRunData,
  renderWorkflowRun,
  type StepRunData,
  type WorkflowRunData,
} from "../../presentation/output/workflow_run_output.ts";
import {
  consumeStream,
  createLibSwampContext,
  parseTags,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
} from "../../libswamp/mod.ts";
import { createWorkflowRunSearchRenderer } from "../../presentation/renderers/workflow_run_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
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
function toRunData(run: WorkflowRun, path?: string): WorkflowRunData {
  const startTime = run.startedAt?.getTime();
  const endTime = run.completedAt?.getTime();

  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    jobs: run.jobs.map((job): JobRunData => {
      const jobStart = job.startedAt?.getTime();
      const jobEnd = job.completedAt?.getTime();

      return {
        name: job.jobName,
        status: job.status,
        steps: job.steps.map((step): StepRunData => {
          const stepStart = step.startedAt?.getTime();
          const stepEnd = step.completedAt?.getTime();

          const stepData: StepRunData = {
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
    repoDir: options.repoDir ?? ".",
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

  const renderer = createWorkflowRunSearchRenderer(effectiveMode);
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
    // Display the run details
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
      renderWorkflowRun(runData, effectiveMode);
    }
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Workflow run search command completed");
}

export const workflowRunSearchCommand = new Command()
  .name("search")
  .description("Search workflow run history")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
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
