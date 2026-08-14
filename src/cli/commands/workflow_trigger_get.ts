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
  type TriggerOverrideEntry,
} from "../../serve/serve_config.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { renderWorkflowTriggerGet } from "../../presentation/renderers/workflow_trigger_get.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type {
  EffectiveTrigger,
  WorkflowTriggerGetResponse,
} from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowTriggerGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description(
      "Show the effective trigger for a workflow (built-in + override)",
    )
    .example(
      "Show effective trigger",
      "swamp workflow trigger get scan-cves",
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
    "get",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowTriggerGetResponse>(
      { server, token },
      {
        type: "workflow.trigger.get",
        payload: { workflowName },
      },
    );
    renderWorkflowTriggerGet(
      cliCtx.outputMode,
      response.data,
    );
    return;
  }

  const repoDir = resolveRepoDir(options.repoDir);

  cliCtx.logger.debug`Getting trigger for workflow ${workflowName}`;

  const config = await readServeConfigFile(repoDir);
  const override: TriggerOverrideEntry | null =
    config?.triggers?.[workflowName] ?? null;

  let builtIn: EffectiveTrigger | null = null;
  try {
    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    const workflow = await repoContext.workflowRepo.findByName(workflowName);
    if (workflow) {
      builtIn = {
        schedule: workflow.schedule ?? null,
        inputs: workflow.triggerInputs ?? {},
      };
    }
  } catch {
    cliCtx.logger.debug(
      "Could not initialize repo for built-in trigger lookup — showing override only",
    );
  }

  const effective: EffectiveTrigger = {
    schedule: override?.schedule ?? builtIn?.schedule ?? null,
    inputs: {
      ...(builtIn?.inputs ?? {}),
      ...(override?.inputs ?? {}),
    },
  };

  renderWorkflowTriggerGet(cliCtx.outputMode, {
    workflowName,
    builtIn,
    override,
    effective,
  });

  cliCtx.logger.debug("Workflow trigger get command completed");
});
