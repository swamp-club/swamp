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

import type { WorkflowTriggerGetResult } from "../../serve/protocol.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export function renderWorkflowTriggerGet(
  mode: OutputMode,
  data: WorkflowTriggerGetResult,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const logger = getSwampLogger(["workflow", "trigger", "get"]);

  if (!data.builtIn && !data.override) {
    logger.info`No trigger configured for workflow ${data.workflowName}`;
    return;
  }

  logger.info`Trigger for ${data.workflowName}:`;

  if (data.builtIn) {
    logger.info("  built-in:");
    if (data.builtIn.schedule) {
      logger.info`    schedule: ${data.builtIn.schedule}`;
    }
    if (Object.keys(data.builtIn.inputs).length > 0) {
      for (const [key, value] of Object.entries(data.builtIn.inputs)) {
        logger.info`    input ${key}: ${value}`;
      }
    }
  }

  if (data.override) {
    logger.info("  override (serve.yaml):");
    if (data.override.schedule) {
      logger.info`    schedule: ${data.override.schedule}`;
    }
    if (data.override.inputs && Object.keys(data.override.inputs).length > 0) {
      for (const [key, value] of Object.entries(data.override.inputs)) {
        logger.info`    input ${key}: ${value}`;
      }
    }
  }

  logger.info("  effective:");
  if (data.effective.schedule) {
    const source = data.override?.schedule ? "override" : "built-in";
    logger.info`    schedule: ${data.effective.schedule} (${source})`;
  } else {
    logger.info("    schedule: (none)");
  }
  if (Object.keys(data.effective.inputs).length > 0) {
    for (const [key, value] of Object.entries(data.effective.inputs)) {
      const source = data.override?.inputs?.[key] !== undefined
        ? "override"
        : "built-in";
      logger.info`    input ${key}: ${value} (${source})`;
    }
  }
}
