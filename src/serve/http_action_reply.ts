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

import { SIGNAL_STATUS } from "./signal_http.ts";
import type { SignalDeliveryResult } from "./signal_delivery.ts";
import {
  AMBIGUOUS_GATE_CODE,
  GATE_REOPENED_CODE,
} from "../libswamp/workflows/gate_refusals.ts";
import {
  REPLICATION_REFUSALS,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
import type { GateState } from "../domain/workflows/gate_state.ts";
import {
  type ResumeRefusal,
  RUN_NOT_SUSPENDED_CODE,
} from "./resume_launcher.ts";

export interface ActionReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

/** answered once a run is accepted; the caller reads status from there */
export const DETACHED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "workflow.run",
  "workflow.resume",
]);

/** no side effect, so these stop when the caller disconnects */
export const READ_ACTION_TYPES: ReadonlySet<string> = new Set([
  "workflow.history.get",
  "workflow.approvals",
]);

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

const NOT_FOUND: Failure = {
  status: 404,
  code: "not_found",
  message: "Not found",
};

const FORBIDDEN: Failure = {
  status: 403,
  code: "forbidden",
  message: "This action is not allowed",
};

const ACTION_FAILED: Failure = {
  status: 500,
  code: "action_failed",
  message: "The action failed",
};

const OUTCOME_UNKNOWN: Failure = {
  status: 500,
  code: "outcome_unknown",
  message: "The action may have taken effect; read its status before retrying",
};

const UNCONFIRMED: Failure = {
  status: 503,
  code: "outcome_unknown",
  message: "The action may have taken effect; read its status before retrying",
  retryAfterSeconds: 5,
};

const BUSY: Failure = {
  status: 409,
  code: "busy",
  message: "Another operation on this run is in progress; try again",
  retryAfterSeconds: 1,
};

const TOO_MANY_RUNS: Failure = {
  status: 429,
  code: "too_many_runs",
  message: "Too many concurrent runs; wait for active runs to complete",
  retryAfterSeconds: 5,
};

// fixed text: a code here is told apart by code, and its handler's message may
// name resources
const FAILURES: Readonly<Record<string, Failure>> = {
  access_not_configured: {
    status: 503,
    code: "access_unavailable",
    message: "Authorization is not available",
    retryAfterSeconds: 5,
  },
  audit_unavailable: {
    status: 503,
    code: "audit_unavailable",
    message: "This action can't be recorded right now",
    retryAfterSeconds: 5,
  },
  too_many_requests: {
    status: 429,
    code: "rate_limited",
    message: "Too Many Requests",
    retryAfterSeconds: 1,
  },
  idempotency_conflict: {
    status: 409,
    code: "idempotency_conflict",
    message: "This idempotency key was already used with different inputs",
  },
  [RUN_NOT_SUSPENDED_CODE]: {
    status: 409,
    code: "run_not_suspended",
    message: "This run is not suspended",
  },
  [REPLICATION_REFUSALS.notLeader]: {
    status: 503,
    code: REPLICATION_REFUSALS.notLeader,
    message: "This serve node does not lead the datastore; try again",
    retryAfterSeconds: 5,
  },
  already_registered: BUSY,
  reserved: BUSY,
  lock_timeout: BUSY,
  global_cap: TOO_MANY_RUNS,
  principal_cap: TOO_MANY_RUNS,
  draining: {
    status: 503,
    code: "shutting_down",
    message: "Serve is shutting down; try again once it is back",
    retryAfterSeconds: 5,
  },
  not_found: NOT_FOUND,
  workflow_not_found: NOT_FOUND,
  cancelled: OUTCOME_UNKNOWN,
  ...Object.fromEntries(
    REPLICATION_REFUSALS.unconfirmed.map((code) => [code, UNCONFIRMED]),
  ),
  [REPLICATION_REFUSALS.writerBusy]: BUSY,
};

const GATE_CLOSED: Failure = {
  status: 409,
  code: "gate_closed",
  message: "This gate can no longer be decided",
};

const GATE_NOT_OPEN: Failure = {
  status: 409,
  code: "gate_not_open",
  message: "This step is not waiting for a decision",
};

const GATE_FAILURES: Readonly<Record<string, Failure>> = {
  absent: NOT_FOUND,
  ambiguous: {
    status: 409,
    code: AMBIGUOUS_GATE_CODE,
    message: "This step name is in more than one job; name the job",
  },
  decided: {
    status: 409,
    code: "already_decided",
    message: "This gate has already been decided",
  },
  expired: GATE_CLOSED,
  closed: GATE_CLOSED,
  nested: GATE_NOT_OPEN,
  not_reached: GATE_NOT_OPEN,
  // refused while the gate still waits, so not a race a retry would settle
  waiting: ACTION_FAILED,
  run_active: BUSY,
  busy: BUSY,
} satisfies Record<GateState | "busy", Failure>;

const GATE_REOPENED: Failure = {
  status: 409,
  code: GATE_REOPENED_CODE,
  message:
    "This gate was asked again; read its current approval and decide again",
};

const RESUME_FAILURES: Readonly<Record<string, Failure>> = {
  not_found: NOT_FOUND,
  nested_pending: {
    status: 409,
    code: "run_not_resumable",
    message: "This run is waiting on another run",
  },
  refused: {
    status: 409,
    code: "run_not_resumable",
    message: "This run can't be resumed now",
  },
} satisfies Record<ResumeRefusal, Failure>;

export const HTTP_ACTION_FAILURE_TABLES = {
  FAILURES,
  GATE_FAILURES,
  RESUME_FAILURES,
};

interface ErrorFrame {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

function detail(details: unknown, name: string): unknown {
  return details !== null && typeof details === "object"
    ? (details as Record<string, unknown>)[name]
    : undefined;
}

function failed(failure: Failure, requestId: string): ActionReply {
  return {
    status: failure.status,
    body: { code: failure.code, message: failure.message, requestId },
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  };
}

function signalRefusal(error: ErrorFrame, requestId: string): ActionReply {
  const refusal = String(detail(error.details, "refusal") ?? "failed");
  const details = error.details as Record<string, unknown> | undefined;
  return {
    status: SIGNAL_STATUS[refusal as SignalDeliveryResult["status"]] ?? 500,
    body: {
      code: refusal,
      message: sanitizeErrorForClient(error.message),
      requestId,
      ...(details?.receipt ? { receipt: details.receipt } : {}),
      ...(details?.pending ? { pending: details.pending } : {}),
      ...(details?.lastWait ? { lastWait: details.lastWait } : {}),
      ...(details?.errors ? { errors: details.errors } : {}),
    },
  };
}

function typedFailure(
  type: string,
  error: ErrorFrame,
  requestId: string,
): ActionReply | undefined {
  switch (error.code) {
    case "unauthorized":
      // these name a run or wait, so a refusal must read like a missing one
      return failed(
        type === "workflow.history.get" || type === "workflow.signal"
          ? NOT_FOUND
          : FORBIDDEN,
        requestId,
      );
    case "workflow_approve_failed":
    case "workflow_reject_failed": {
      const refusal = detail(error.details, "refusalCode");
      if (refusal === GATE_REOPENED_CODE) {
        return failed(GATE_REOPENED, requestId);
      }
      if (refusal === AMBIGUOUS_GATE_CODE) {
        return failed(GATE_FAILURES.ambiguous, requestId);
      }
      const gate = GATE_FAILURES[String(detail(error.details, "gateState"))];
      return gate ? failed(gate, requestId) : undefined;
    }
    case "workflow_resume_failed": {
      const refusal =
        RESUME_FAILURES[String(detail(error.details, "resumeRefusal"))];
      return refusal ? failed(refusal, requestId) : undefined;
    }
    case "workflow_history_get_failed":
      return detail(error.details, "reason") === "not_found"
        ? failed(NOT_FOUND, requestId)
        : undefined;
    case "workflow_signal_refused":
      return signalRefusal(error, requestId);
    case "input_validation_failed":
    case "invalid_request":
      return {
        status: 400,
        body: {
          code: "invalid_request",
          message: sanitizeErrorForClient(error.message),
          requestId,
        },
      };
    default:
      return undefined;
  }
}

export function actionFailure(
  type: string,
  error: ErrorFrame,
  requestId: string,
): ActionReply {
  const typed = typedFailure(type, error, requestId);
  if (typed) return typed;
  return failed(FAILURES[error.code] ?? ACTION_FAILED, requestId);
}

export interface ActionFrame {
  readonly type: string;
  readonly error?: ErrorFrame;
  readonly payload?: unknown;
  readonly event?: {
    readonly kind?: string;
    readonly error?: ErrorFrame;
    readonly runId?: string;
    readonly workflowName?: string;
    readonly parentRunId?: string;
    readonly replayed?: boolean;
  };
}

/** the reply a frame settles the request with, or undefined for progress */
export function actionReplyForFrame(
  type: string,
  message: ActionFrame,
  requestId: string,
): ActionReply | undefined {
  if (message.type === "error" && message.error) {
    return actionFailure(type, message.error, requestId);
  }
  if (message.type === "event") {
    const event = message.event;
    if (!event || !DETACHED_ACTION_TYPES.has(type)) return undefined;
    if (event.kind === "error" && event.error) {
      return actionFailure(type, event.error, requestId);
    }
    if (event.kind === "started" && event.parentRunId === undefined) {
      return {
        status: 202,
        body: {
          requestId,
          type,
          data: {
            runId: event.runId,
            workflowName: event.workflowName,
            replayed: event.replayed === true,
          },
        },
      };
    }
    return undefined;
  }
  if (message.type === "done") {
    return DETACHED_ACTION_TYPES.has(type)
      ? failed(
        {
          status: 500,
          code: "run_not_started",
          message: "The server ended the request before the run started",
        },
        requestId,
      )
      : undefined;
  }
  if (message.type === type) {
    return actionSuccess(type, message.payload, requestId);
  }
  return undefined;
}

/** where the record lives on the server is nothing an integration can use */
function withoutServerPath(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const { path: _path, ...rest } = data as Record<string, unknown>;
  return rest;
}

function actionSuccess(
  type: string,
  payload: unknown,
  requestId: string,
): ActionReply {
  const held = type === "workflow.signal" &&
    (detail(payload, "pending") !== undefined ||
      detail(payload, "accepted") !== undefined);
  const found = detail(payload, "data");
  const data = found !== undefined ? found : payload;
  return {
    status: held ? 202 : 200,
    body: {
      requestId,
      type,
      data: type === "workflow.history.get" ? withoutServerPath(data) : data,
    },
  };
}

/** the handler ended with no reply, as when a revoked token closes its socket */
export function actionReplyForEnd(requestId: string): ActionReply {
  return failed(OUTCOME_UNKNOWN, requestId);
}

export function actionResponse(reply: ActionReply): {
  status: number;
  text: string;
  headers: Record<string, string>;
} {
  return {
    status: reply.status,
    text: JSON.stringify(reply.body),
    headers: {
      "content-type": "application/json",
      ...(reply.retryAfterSeconds !== undefined
        ? { "retry-after": String(reply.retryAfterSeconds) }
        : {}),
    },
  };
}
