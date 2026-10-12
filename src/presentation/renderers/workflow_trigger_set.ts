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

import type { TriggerOverrideEntry } from "../../serve/serve_config.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export interface WorkflowTriggerSetData {
  readonly workflowName: string;
  /** The override as stored; `{}` when a resume left nothing to store. */
  readonly entry: TriggerOverrideEntry;
  /** The pause state the command asked for, when it asked for one. */
  readonly paused?: boolean;
}

export interface WorkflowTriggerSetRenderOptions {
  /**
   * The command set a schedule (`--schedule`). Without one, a pause or
   * resume reports only that, not the stored schedule it left alone.
   * Defaults to true unless the command asked for a pause state.
   */
  readonly scheduleSet?: boolean;
}

export function renderWorkflowTriggerSet(
  mode: OutputMode,
  data: WorkflowTriggerSetData,
  options: WorkflowTriggerSetRenderOptions = {},
): void {
  const scheduleSet = options.scheduleSet ?? data.paused === undefined;
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "trigger", "set"]);
    if (scheduleSet && data.entry.schedule !== undefined) {
      logger
        .info`Set trigger override for ${data.workflowName}: schedule ${data.entry.schedule}`;
    }
    if (
      scheduleSet && data.entry.inputs &&
      Object.keys(data.entry.inputs).length > 0
    ) {
      logger.info`  inputs: ${
        Object.entries(data.entry.inputs).map(([k, v]) => `${k}=${v}`).join(
          ", ",
        )
      }`;
    }
    if (data.paused === true) {
      logger.info`Paused the schedule of ${data.workflowName}`;
    } else if (data.paused === false) {
      logger.info`Resumed the schedule of ${data.workflowName}`;
    } else if (data.entry.paused === true) {
      logger.info`  the schedule stays paused`;
    }
  }
}
