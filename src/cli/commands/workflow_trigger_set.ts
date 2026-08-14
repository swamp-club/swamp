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
  validateTriggerOverrideEntry,
  writeServeConfigFile,
} from "../../serve/serve_config.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { renderWorkflowTriggerSet } from "../../presentation/renderers/workflow_trigger_set.ts";
import { UserError } from "../../domain/errors.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkflowTriggerSetResponse } from "../../serve/protocol.ts";

export function parseInputFlag(
  input: string,
): { key: string; value: string } {
  const equalsIndex = input.indexOf("=");
  if (equalsIndex === -1 || equalsIndex === 0) {
    throw new UserError(
      `Invalid --input format: '${input}'. Expected key=value.`,
    );
  }
  return {
    key: input.substring(0, equalsIndex),
    value: input.substring(equalsIndex + 1),
  };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowTriggerSetCommand = withRemoteOptions(
  new Command()
    .name("set")
    .description("Set a trigger override for a workflow in serve.yaml")
    .example(
      "Override schedule",
      'swamp workflow trigger set scan-cves --schedule "0 3 * * *"',
    )
    .example(
      "Override schedule with inputs",
      'swamp workflow trigger set @swamp/cve/researcher/scan --schedule "0 12 * * 1" --input channel=#security',
    )
    .arguments("<workflow_name:string>")
    .option(
      "--schedule <cron:string>",
      "Cron expression for the trigger schedule",
      { required: true },
    )
    .option("--input <value:string>", "Input values (key=value, repeatable)", {
      collect: true,
    })
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions, workflowName: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "workflow",
    "trigger",
    "set",
  ]);

  const inputs: Record<string, unknown> = {};
  if (options.input) {
    for (const raw of options.input as string[]) {
      const { key, value } = parseInputFlag(raw);
      inputs[key] = value;
    }
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkflowTriggerSetResponse>(
      { server, token },
      {
        type: "workflow.trigger.set",
        payload: {
          workflowName,
          schedule: options.schedule as string,
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        },
      },
    );
    const data = response.data as unknown as {
      workflowName: string;
      entry: TriggerOverrideEntry;
    };
    renderWorkflowTriggerSet(cliCtx.outputMode, {
      workflowName: data.workflowName,
      entry: data.entry,
    });
    return;
  }

  const repoDir = resolveRepoDir(options.repoDir);

  const entry: TriggerOverrideEntry = {
    schedule: options.schedule as string,
  };

  const entryWithInputs: TriggerOverrideEntry = Object.keys(inputs).length > 0
    ? { ...entry, inputs }
    : entry;

  const configPath = `${repoDir}/.swamp/serve.yaml`;
  validateTriggerOverrideEntry(entryWithInputs, configPath, workflowName);

  cliCtx.logger.debug`Setting trigger override for workflow ${workflowName}`;

  const config = await readServeConfigFile(repoDir) ?? {};
  const triggers = config.triggers ?? {};
  triggers[workflowName] = entryWithInputs;
  config.triggers = triggers;

  await writeServeConfigFile(repoDir, config);

  renderWorkflowTriggerSet(cliCtx.outputMode, {
    workflowName,
    entry: entryWithInputs,
  });

  cliCtx.logger.debug("Workflow trigger set command completed");
});
