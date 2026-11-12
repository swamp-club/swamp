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

import {
  type ControlAction,
  type ControlOutcome,
  createControlTelemetry,
  type ServeTelemetryCaller,
} from "./telemetry.ts";
import { isServerFailureCode, watchRequestError } from "./handlers/shared.ts";

export interface ControlRecording {
  /** the request was answered; its first error code, if any, is the outcome */
  settle(): Promise<void>;
  /** the request threw instead of answering */
  fail(): Promise<void>;
  /** for a route that knows its outcome without an error reply */
  finish(outcome: ControlOutcome): Promise<void>;
  /** the request went to another node, which records it */
  discard(): void;
}

function outcomeOf(code: string | undefined): ControlOutcome {
  if (code === undefined) return { status: "success" };
  return {
    status: isServerFailureCode(code) ? "error" : "user_error",
    errorType: code,
  };
}

export function recordControl(
  socket: WebSocket,
  requestId: string,
  action: ControlAction,
  caller: ServeTelemetryCaller,
): ControlRecording {
  const telemetry = createControlTelemetry(action, caller);
  const firstError = watchRequestError(socket, requestId);
  return {
    settle: () => telemetry.finish(outcomeOf(firstError())),
    fail: () => {
      const code = firstError();
      return telemetry.finish(
        code === undefined
          ? { status: "error", errorType: "internal" }
          : outcomeOf(code),
      );
    },
    finish: (outcome) => {
      firstError();
      return telemetry.finish(outcome);
    },
    discard: () => {
      firstError();
      telemetry.discard();
    },
  };
}

const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: "invalid_request",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "invalid_request",
  415: "invalid_request",
  503: "unavailable",
};

/** an HTTP route's outcome, read from the status it answered with */
export function httpControlOutcome(
  status: number,
  cancelledCount?: number,
): ControlOutcome {
  const count = cancelledCount === undefined ? {} : { cancelledCount };
  if (status < 400) return { status: "success", ...count };
  return {
    status: status >= 500 ? "error" : "user_error",
    errorType: HTTP_STATUS_CODES[status] ?? `http_${status}`,
    ...count,
  };
}

const WORKFLOW_CONTROL_ACTIONS: Readonly<Record<string, ControlAction>> = {
  "workflow.approve": "approve",
  "workflow.reject": "reject",
  "workflow.resume": "resume",
  "workflow.signal": "signal",
  "workflow.cancel": "cancel",
};

export function workflowControlActionOf(
  requestType: string,
): ControlAction | undefined {
  return WORKFLOW_CONTROL_ACTIONS[requestType];
}
