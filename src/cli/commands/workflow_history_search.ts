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
  type JobRunView,
  parseTags,
  type StepRunView,
  workflowHistorySearch,
  type WorkflowHistorySearchData,
  type WorkflowHistorySearchDeps,
  type WorkflowHistorySearchItem,
  type WorkflowRunView,
} from "../../libswamp/mod.ts";
import { renderWorkflowRunDisplay } from "../../presentation/renderers/workflow_run_display.ts";
import { createWorkflowHistorySearchRenderer } from "../../presentation/renderers/workflow_history_search.tsx";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { checkUnmigratedNamespaceData } from "../resolve_datastore.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowHistorySearchResponse } from "../../serve/protocol.ts";

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
function createHistoryFetchPreview(
  runRepo: YamlWorkflowRunRepository,
): (item: WorkflowHistorySearchItem) => Promise<WorkflowRunView> {
  return async (
    item: WorkflowHistorySearchItem,
  ): Promise<WorkflowRunView> => {
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

export async function workflowHistorySearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(
    options as GlobalOptions,
    ["workflow", "history", "search"],
  );
  const effectiveMode = interactiveOutputMode(ctx);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const parsedInputs = options.input
      ? parseTags(options.input as string[])
      : undefined;
    const response = await requestServerResponse<
      WorkflowHistorySearchResponse
    >(
      { server, token },
      {
        type: "workflow.history.search",
        payload: { query, inputs: parsedInputs },
      },
    );
    const renderer = createWorkflowHistorySearchRenderer(effectiveMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as WorkflowHistorySearchData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching workflow history with query: ${query ?? "(none)"}`;

  const { repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: effectiveMode,
    });
  const workflowRepo = repoContext.workflowRepo;
  const runRepo = repoContext.workflowRunRepo;

  const deps: WorkflowHistorySearchDeps = {
    findAllWorkflows: () => workflowRepo.findAll(),
    // Use the lightweight summary projection, not the full-aggregate read:
    // search only displays summary fields, and hydrating every run (with its
    // inline step outputs) OOMs on workflows with a large run history (#1173).
    findAllRunsByWorkflowId: (id) =>
      runRepo.findAllSummariesFromIndex(createWorkflowId(id)),
  };

  const fetchPreview = effectiveMode === "log"
    ? createHistoryFetchPreview(runRepo)
    : undefined;

  const renderer = createWorkflowHistorySearchRenderer(
    effectiveMode,
    fetchPreview,
  );
  const parsedInputs = options.input
    ? parseTags(options.input as string[])
    : undefined;

  let resultCount = 0;
  const handlers = renderer.handlers();
  const origCompleted = handlers.completed;
  handlers.completed = (e) => {
    resultCount = e.data.results.length;
    origCompleted(e);
  };

  await consumeStream(
    workflowHistorySearch(libCtx, deps, { query, inputs: parsedInputs }),
    handlers,
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
  } else {
    ctx.logger.debug`Search completed with no selection`;
  }

  if (resultCount === 0) {
    const dsConfig = datastoreResolver.config();
    const unmigrated = await checkUnmigratedNamespaceData(dsConfig);
    if (unmigrated.length > 0) {
      ctx.logger.warn(
        "Un-migrated data found at root level ({dirs}). " +
          "Run 'swamp datastore namespace migrate' to preview, " +
          'then --confirm to move data under the "{namespace}" namespace.',
        { dirs: unmigrated.join(", "), namespace: dsConfig.namespace },
      );
    }
  }

  ctx.logger.debug("Workflow history search command completed");
}

export const workflowHistorySearchCommand = withRemoteOptions(
  new Command()
    .name("search")
    .description("Search workflow run history")
    .example("Browse run history", "swamp workflow history search")
    .example("Search runs", "swamp workflow history search deploy")
    .arguments("[query:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--input <input:string>",
      "Filter by workflow input (KEY=VALUE), can be repeated",
      { collect: true },
    ),
).action(workflowHistorySearchAction);
