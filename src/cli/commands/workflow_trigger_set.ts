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
import { join } from "@std/path";
import {
  mergeTriggerOverride,
  readServeConfigFile,
  SERVE_CONFIG_PATH,
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
  resolveServerTokenFromOptions,
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
    .example(
      "Pause a workflow's schedule",
      "swamp workflow trigger set scan-cves --paused",
    )
    .example(
      "Resume a paused schedule",
      "swamp workflow trigger set scan-cves --resume",
    )
    .arguments("<workflow_name:string>")
    .option(
      "--schedule <cron:string>",
      "Cron expression for the trigger schedule (replaces the override's schedule and inputs)",
    )
    .option(
      "--input <value:string>",
      "Input values (key=value, repeatable; JSON syntax not supported)",
      {
        collect: true,
      },
    )
    .option(
      "--paused",
      "Pause the workflow's schedule (built-in or overridden) until resumed",
      { conflicts: ["resume"] },
    )
    .option(
      "--resume",
      "Resume a paused schedule; the next run is the next cron tick from now",
    )
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

  const schedule = options.schedule as string | undefined;
  const paused: boolean | undefined = options.paused
    ? true
    : options.resume
    ? false
    : undefined;
  if (schedule === undefined && paused === undefined) {
    throw new UserError(
      "Specify --schedule, --paused or --resume.",
    );
  }
  if (schedule === undefined && Object.keys(inputs).length > 0) {
    throw new UserError("--input requires --schedule.");
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<WorkflowTriggerSetResponse>(
      { server, token },
      {
        type: "workflow.trigger.set",
        payload: {
          workflowName,
          ...(schedule !== undefined ? { schedule } : {}),
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          ...(paused !== undefined ? { paused } : {}),
        },
      },
    );
    renderWorkflowTriggerSet(cliCtx.outputMode, {
      workflowName: response.data.workflowName,
      entry: response.data.entry,
      ...(paused !== undefined ? { paused } : {}),
    }, { scheduleSet: schedule !== undefined });
    return;
  }

  const repoDir = resolveRepoDir(options.repoDir);

  cliCtx.logger.debug`Setting trigger override for workflow ${workflowName}`;

  const config = await readServeConfigFile(repoDir) ?? {};
  const triggers = config.triggers ?? {};
  const entry = mergeTriggerOverride(triggers[workflowName], {
    schedule,
    inputs,
    paused,
  });

  const configPath = join(repoDir, SERVE_CONFIG_PATH);
  if (entry) {
    validateTriggerOverrideEntry(entry, configPath, workflowName);
    triggers[workflowName] = entry;
  } else {
    delete triggers[workflowName];
  }
  if (Object.keys(triggers).length > 0) {
    config.triggers = triggers;
  } else {
    delete config.triggers;
  }

  await writeServeConfigFile(repoDir, config);

  renderWorkflowTriggerSet(cliCtx.outputMode, {
    workflowName,
    entry: entry ?? {},
    ...(paused !== undefined ? { paused } : {}),
  }, { scheduleSet: schedule !== undefined });

  cliCtx.logger.debug("Workflow trigger set command completed");
});
