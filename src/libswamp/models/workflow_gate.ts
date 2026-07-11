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

import type {
  WorkflowGateApproveOptions,
  WorkflowGateRejectOptions,
  WorkflowGateResult,
} from "../../domain/models/model.ts";
import type { WorkflowGateService } from "../../domain/models/workflow_gate_service.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import { createLibSwampContext } from "../context.ts";
import { workflowApprove } from "../workflows/approve.ts";
import { workflowReject } from "../workflows/reject.ts";
import { result } from "../stream.ts";
import type { SwampError } from "../errors.ts";
import type { Logger } from "@logtape/logtape";

export function createWorkflowGateService(
  workflowRepo: WorkflowRepository,
  runRepo: WorkflowRunRepository,
): WorkflowGateService {
  return {
    async approve(
      options: WorkflowGateApproveOptions,
      callerContext: { definitionName: string; methodName: string },
      signal: AbortSignal,
      logger: Logger,
    ): Promise<WorkflowGateResult> {
      const ctx = createLibSwampContext({ signal, logger });
      const decidedBy =
        `model:${callerContext.definitionName}/${callerContext.methodName}`;

      try {
        const completed = await result(
          workflowApprove(ctx, { workflowRepo, runRepo }, {
            workflowIdOrName: options.workflowIdOrName,
            stepName: options.stepName,
            runId: options.runId,
            reason: options.reason,
            decidedBy,
          }),
        );
        return {
          ok: true,
          runId: completed.data.runId,
          workflowName: completed.data.workflowName,
          stepName: completed.data.stepName,
          approved: true,
          decidedBy,
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            message: isSwampError(error)
              ? error.message
              : error instanceof Error
              ? error.message
              : String(error),
          },
        };
      }
    },

    async reject(
      options: WorkflowGateRejectOptions,
      callerContext: { definitionName: string; methodName: string },
      signal: AbortSignal,
      logger: Logger,
    ): Promise<WorkflowGateResult> {
      const ctx = createLibSwampContext({ signal, logger });
      const decidedBy =
        `model:${callerContext.definitionName}/${callerContext.methodName}`;

      try {
        const completed = await result(
          workflowReject(ctx, { workflowRepo, runRepo }, {
            workflowIdOrName: options.workflowIdOrName,
            stepName: options.stepName,
            runId: options.runId,
            reason: options.reason,
            decidedBy,
          }),
        );
        return {
          ok: true,
          runId: completed.data.runId,
          workflowName: completed.data.workflowName,
          stepName: completed.data.stepName,
          approved: false,
          decidedBy,
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            message: isSwampError(error)
              ? error.message
              : error instanceof Error
              ? error.message
              : String(error),
          },
        };
      }
    },
  };
}

function isSwampError(error: unknown): error is SwampError {
  return typeof error === "object" && error !== null && "code" in error &&
    "message" in error;
}
