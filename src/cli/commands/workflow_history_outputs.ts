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
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../../libswamp/workflows/history_get.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowHistoryGetResponse } from "../../serve/protocol.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { writeJsonValue } from "../../presentation/output/json_stream.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * the run read whole carries no partial step, so one means a server that read
 * within its budget; refused rather than printed incomplete
 */
export function stepOutputsOf(
  runView: WorkflowRunView,
): Record<string, Record<string, unknown>> {
  const outputs: Record<string, Record<string, unknown>> = {};
  const partial: string[] = [];
  for (const job of runView.jobs) {
    for (const step of job.steps) {
      if (step.outputsPartial) partial.push(step.name);
      if (step.outputs && Object.keys(step.outputs).length > 0) {
        outputs[step.name] = step.outputs;
      }
    }
  }
  if (partial.length > 0) {
    throw new UserError(
      `The server returned partial outputs for ${
        partial.join(", ")
      }: it read only part of the run's resources. Upgrade the server, or run without --server.`,
    );
  }
  return outputs;
}

export async function workflowHistoryOutputsAction(
  options: AnyOptions,
  runIdOrWorkflow: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "history",
    "outputs",
  ]);

  let runView: WorkflowRunView | undefined;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<WorkflowHistoryGetResponse>(
      { server, token },
      {
        type: "workflow.history.get",
        payload: { workflowIdOrName: runIdOrWorkflow, allAttributes: true },
      },
    );
    runView = response.data as unknown as WorkflowRunView;
  } else {
    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowHistoryGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.workflowRepo,
      undefined,
      undefined,
      repoContext.unreadableContent,
      repoContext.workflowRunRepo.recordsAreForwarded,
    );

    for await (
      const event of workflowHistoryGet(ctx, deps, runIdOrWorkflow, {
        includeOutputs: true,
        allAttributes: true,
      })
    ) {
      if (event.kind === "completed") {
        runView = event.data;
      }
    }
  }

  if (!runView) {
    throw new UserError(`Run not found: ${runIdOrWorkflow}`);
  }

  const outputs = stepOutputsOf(runView);

  if (cliCtx.outputMode === "json") {
    await writeJsonValue(outputs);
  } else {
    if (Object.keys(outputs).length === 0) {
      writeOutput("No step outputs found for this run.");
    } else {
      for (const [stepName, stepOutputs] of Object.entries(outputs)) {
        writeOutput(`${stepName}:`);
        for (const [key, value] of Object.entries(stepOutputs)) {
          writeOutput(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
  }
}

export const workflowHistoryOutputsCommand = withRemoteOptions(
  new Command()
    .name("outputs")
    .description("Show step outputs for a workflow run")
    .example(
      "Show outputs by run ID",
      "swamp workflow history outputs abc123",
    )
    .example(
      "Show outputs for latest run",
      "swamp workflow history outputs deploy-pipeline",
    )
    .arguments("<run_id_or_workflow:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(workflowHistoryOutputsAction);
