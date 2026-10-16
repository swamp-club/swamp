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
import { consumeStream } from "../../libswamp/stream.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import {
  workflowSchedulePause,
  type WorkflowSchedulePauseData,
} from "../../libswamp/workflows/schedule.ts";
import { renderWorkflowSchedulePause } from "../../presentation/renderers/workflow_schedule.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveCliInitiatedBy } from "../auth_context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowSchedulePauseResponse } from "../../serve/protocol.ts";
import { localWorkflowScheduleDeps } from "./workflow_schedule_deps.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowSchedulePauseCommand = withRemoteOptions(
  new Command()
    .name("pause")
    .description(
      "Pause a workflow's schedule without editing its definition; manual and webhook runs still run",
    )
    .example(
      "Pause during an incident",
      'swamp workflow schedule pause nightly-gc --reason "stalling serve, see #3518"',
    )
    .example(
      "Pause for two hours",
      "swamp workflow schedule pause nightly-gc --until 2h",
    )
    .arguments("<workflow_id_or_name:string>")
    .option(
      "--reason <text:string>",
      "Why the schedule is paused; shown in list and logged at each skipped fire",
    )
    .option(
      "--until <time:string>",
      "Resume automatically: a duration (30m, 2h, 1d, 1w) or an ISO-8601 time with Z or an offset",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, workflowIdOrName: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "schedule",
    "pause",
  ]);
  const reason = options.reason as string | undefined;
  const until = options.until as string | undefined;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<
      WorkflowSchedulePauseResponse
    >(
      { server, token },
      {
        type: "workflow.schedule.pause",
        payload: {
          workflowIdOrName,
          ...(reason !== undefined ? { reason } : {}),
          ...(until !== undefined ? { until } : {}),
        },
      },
    );
    renderWorkflowSchedulePause(cliCtx.outputMode, response.data);
    return;
  }

  const { ctx, deps } = await localWorkflowScheduleDeps(
    resolveRepoDir(options.repoDir),
    cliCtx.outputMode,
    cliCtx.logger,
  );
  let result: WorkflowSchedulePauseData | undefined;
  await consumeStream(
    workflowSchedulePause(ctx, deps, {
      workflowIdOrName,
      reason,
      until,
      pausedBy: await resolveCliInitiatedBy(),
    }),
    {
      pausing: () => {},
      completed: (e) => {
        result = e.data;
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    },
  );
  if (result) renderWorkflowSchedulePause(cliCtx.outputMode, result);
});
