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
  workflowScheduleResume,
  type WorkflowScheduleResumeData,
} from "../../libswamp/workflows/schedule.ts";
import { renderWorkflowScheduleResume } from "../../presentation/renderers/workflow_schedule.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowScheduleResumeResponse } from "../../serve/protocol.ts";
import { localWorkflowScheduleDeps } from "./workflow_schedule_deps.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowScheduleResumeCommand = withRemoteOptions(
  new Command()
    .name("resume")
    .description(
      "Resume a paused workflow schedule (to continue a suspended run, use 'swamp workflow resume')",
    )
    .example(
      "Resume a schedule",
      "swamp workflow schedule resume nightly-gc",
    )
    .arguments("<workflow_id_or_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, workflowIdOrName: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "schedule",
    "resume",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<
      WorkflowScheduleResumeResponse
    >(
      { server, token },
      {
        type: "workflow.schedule.resume",
        payload: { workflowIdOrName },
      },
    );
    renderWorkflowScheduleResume(cliCtx.outputMode, response.data);
    return;
  }

  const { ctx, deps } = await localWorkflowScheduleDeps(
    resolveRepoDir(options.repoDir),
    cliCtx.outputMode,
    cliCtx.logger,
  );
  let result: WorkflowScheduleResumeData | undefined;
  await consumeStream(
    workflowScheduleResume(ctx, deps, { workflowIdOrName }),
    {
      resuming: () => {},
      completed: (e) => {
        result = e.data;
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    },
  );
  if (result) renderWorkflowScheduleResume(cliCtx.outputMode, result);
});
