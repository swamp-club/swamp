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
  readonly entry: TriggerOverrideEntry;
}

export function renderWorkflowTriggerSet(
  mode: OutputMode,
  data: WorkflowTriggerSetData,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["workflow", "trigger", "set"]);
    logger
      .info`Set trigger override for ${data.workflowName}: schedule ${data.entry.schedule}`;
    if (data.entry.inputs && Object.keys(data.entry.inputs).length > 0) {
      logger.info`  inputs: ${
        Object.entries(data.entry.inputs).map(([k, v]) => `${k}=${v}`).join(
          ", ",
        )
      }`;
    }
  }
}
