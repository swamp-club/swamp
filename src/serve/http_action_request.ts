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

import { z } from "zod";
import { isIdempotencyKey } from "../domain/workflows/signal_wait.ts";
import { ANONYMOUS_PRINCIPAL } from "./http_caller_auth.ts";
import { HTTP_ACTION_TYPES } from "./protocol.ts";

const RunIdSchema = z.string().uuid().transform((id) => id.toLowerCase());

const IdempotencyKeySchema = z.string().refine(
  isIdempotencyKey,
  "is not a valid idempotency key",
);

const InputsSchema = z.record(z.string(), z.unknown());

const TraceFields = {
  traceparent: z.string().max(256).optional(),
  tracestate: z.string().max(1024).optional(),
};

const DecisionSchema = z.strictObject({
  workflowIdOrName: z.string().min(1),
  runId: RunIdSchema,
  stepName: z.string().min(1),
  jobName: z.string().min(1).optional(),
  suspendedAt: z.string().datetime(),
  reason: z.string().optional(),
});

interface ActionContext {
  /** authorization is off, so the caller has no principal to record */
  readonly anonymous: boolean;
}

interface ActionRule {
  readonly schema: z.ZodType;
  /** adds what serve sets itself, so none of it can come from the caller */
  readonly frame: (
    payload: never,
    context: ActionContext,
  ) => Record<string, unknown> | undefined;
}

// fields left out here are refused rather than ignored: lockHolderTokens claims
// held locks, decidedBy claims a decider, and skip* turns off a workflow's checks
export const HTTP_ACTION_RULES: Readonly<Record<string, ActionRule>> = {
  "workflow.run": {
    schema: z.strictObject({
      workflowIdOrName: z.string().min(1),
      idempotencyKey: IdempotencyKeySchema,
      inputs: InputsSchema.optional(),
      runtimeTags: z.record(z.string(), z.string()).optional(),
      ...TraceFields,
    }),
    frame: (payload: Record<string, unknown>) => payload,
  },
  "workflow.resume": {
    schema: z.strictObject({
      workflowIdOrName: z.string().min(1),
      runId: RunIdSchema,
      inputs: InputsSchema.optional(),
      ...TraceFields,
    }),
    frame: (payload: Record<string, unknown>) => ({
      ...payload,
      suspendedOnly: true,
    }),
  },
  "workflow.history.get": {
    schema: z.strictObject({ runId: RunIdSchema }),
    frame: (payload: { runId: string }) => ({
      workflowIdOrName: payload.runId,
      exactRun: true,
    }),
  },
  "workflow.approvals": {
    schema: z.strictObject({}),
    frame: () => undefined,
  },
  "workflow.approve": {
    schema: DecisionSchema,
    frame: decisionFrame,
  },
  "workflow.reject": {
    schema: DecisionSchema,
    frame: decisionFrame,
  },
  "workflow.signal": {
    schema: z.union([
      z.strictObject({
        waitId: z.string().max(64),
        payload: z.unknown(),
        idempotencyKey: IdempotencyKeySchema.optional(),
      }),
      z.strictObject({
        workflow: z.string().min(1),
        key: z.string().min(1),
        payload: z.unknown(),
        idempotencyKey: IdempotencyKeySchema.optional(),
      }),
    ]),
    frame: (payload: Record<string, unknown>) =>
      "waitId" in payload
        ? payload
        : { ...payload, acceptsPending: true, acceptsReceipt: true },
  },
};

// without a principal, approve would otherwise record the serve host's user
function decisionFrame(
  payload: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  return {
    ...payload,
    strictGate: true,
    ...(context.anonymous ? { decidedBy: ANONYMOUS_PRINCIPAL } : {}),
  };
}

const EnvelopeSchema = z.strictObject({
  type: z.string(),
  payload: z.unknown().optional(),
});

export type ActionRequest =
  | {
    readonly ok: true;
    readonly type: string;
    readonly frame: string;
    readonly requestId: string;
  }
  | {
    readonly ok: false;
    readonly reason: "type_not_allowed";
    readonly type: string;
  }
  | {
    readonly ok: false;
    readonly reason: "invalid_request";
    readonly message: string;
  };

function firstIssue(error: z.ZodError, type?: string): string {
  // a union's issue names no field, and the two forms are the useful answer
  if (type === "workflow.signal") {
    return "Provide waitId, or workflow and key, with payload and idempotencyKey";
  }
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** the frame is built here so its id and every server-set field are serve's */
export function parseActionRequest(
  raw: unknown,
  context: ActionContext,
): ActionRequest {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return {
      ok: false,
      reason: "invalid_request",
      message: firstIssue(envelope.error),
    };
  }
  const { type, payload } = envelope.data;
  const rule = HTTP_ACTION_TYPES.has(type)
    ? HTTP_ACTION_RULES[type]
    : undefined;
  if (!rule) return { ok: false, reason: "type_not_allowed", type };
  const parsed = rule.schema.safeParse(payload ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_request",
      message: firstIssue(parsed.error, type),
    };
  }
  const requestId = crypto.randomUUID();
  const frame = (rule.frame as (
    payload: unknown,
    context: ActionContext,
  ) => Record<string, unknown> | undefined)(parsed.data, context);
  return {
    ok: true,
    type,
    requestId,
    frame: JSON.stringify({
      type,
      id: requestId,
      ...(frame !== undefined ? { payload: frame } : {}),
    }),
  };
}
