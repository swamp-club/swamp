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
  readServeConfigFile,
  writeServeConfigFile,
} from "../../serve/serve_config.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { renderWorkflowTriggerRemove } from "../../presentation/renderers/workflow_trigger_remove.ts";
import { UserError } from "../../domain/errors.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowTriggerRemoveResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowTriggerRemoveCommand = withRemoteOptions(
  new Command()
    .name("remove")
    .description("Remove a trigger override for a workflow from serve.yaml")
    .example(
      "Remove trigger override",
      "swamp workflow trigger remove scan-cves",
    )
    .arguments("<workflow_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, workflowName: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "trigger",
    "remove",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const _response = await requestServerResponse<
      WorkflowTriggerRemoveResponse
    >(
      { server, token },
      {
        type: "workflow.trigger.remove",
        payload: { workflowName },
      },
    );
    renderWorkflowTriggerRemove(cliCtx.outputMode, { workflowName });
    return;
  }

  const repoDir = resolveRepoDir(options.repoDir);

  cliCtx.logger.debug`Removing trigger override for workflow ${workflowName}`;

  const config = await readServeConfigFile(repoDir);
  if (!config?.triggers?.[workflowName]) {
    throw new UserError(
      `No trigger override found for workflow '${workflowName}' in serve.yaml`,
    );
  }

  delete config.triggers[workflowName];
  if (Object.keys(config.triggers).length === 0) {
    delete config.triggers;
  }

  await writeServeConfigFile(repoDir, config);

  renderWorkflowTriggerRemove(cliCtx.outputMode, { workflowName });

  cliCtx.logger.debug("Workflow trigger remove command completed");
});
