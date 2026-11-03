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
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

export const PENDING_DISPATCH_MODEL_TYPE = ModelType.create(
  "swamp/pending-dispatch",
);

export const PENDING_DISPATCH_INSTANCE_NAME = "pending";

export const PendingDispatchStateSchema = z.enum([
  "waiting",
  "dispatched",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export type PendingDispatchState = z.infer<typeof PendingDispatchStateSchema>;

export const TERMINAL_PENDING_DISPATCH_STATES: ReadonlySet<
  PendingDispatchState
> = new Set([
  "dispatched",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export const PendingDispatchSchema = z.object({
  queueId: z.string(),
  state: PendingDispatchStateSchema,
  target: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  platform: z.string().optional(),
  workflowName: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
  modelType: z.string(),
  methodName: z.string(),
  queuedAt: z.string().datetime(),
  dispatchId: z.string().optional(),
  endedAt: z.string().datetime().optional(),
});

export type PendingDispatch = z.infer<typeof PendingDispatchSchema>;

export function pendingDataName(queueId: string): string {
  return `pending-${queueId}`;
}

export function parseStoredPendingDispatch(
  queueId: string,
  raw: unknown,
): PendingDispatch {
  if (raw === null) {
    throw new Error(`Pending dispatch '${queueId}' does not exist`);
  }
  return PendingDispatchSchema.parse(raw);
}

const EnqueueArgsSchema = z.object({
  queueId: z.string().min(1),
  target: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  platform: z.string().optional(),
  workflowName: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
  modelType: z.string(),
  methodName: z.string(),
  queuedAt: z.string().datetime(),
});

export type EnqueuePendingArgs = z.infer<typeof EnqueueArgsSchema>;

export type PendingDispatchEnd =
  | { state: "dispatched"; dispatchId: string; endedAt: string }
  | {
    state: Extract<
      PendingDispatchState,
      "timed_out" | "cancelled" | "orphaned"
    >;
    endedAt: string;
  };

export const PENDING_DISPATCH_END_METHODS: Readonly<
  Record<PendingDispatchEnd["state"], string>
> = {
  dispatched: "mark_dispatched",
  timed_out: "timeout",
  cancelled: "cancel",
  orphaned: "orphan",
};

// the methods and serve's PendingDispatchLedger both apply these, so their records match
export function startPendingDispatch(
  args: EnqueuePendingArgs,
  existing: unknown,
): PendingDispatch {
  if (existing !== null) {
    throw new Error(`Pending dispatch '${args.queueId}' already exists`);
  }
  // through the schema the end transitions read with, so a key it drops is dropped here too
  return PendingDispatchSchema.parse({ ...args, state: "waiting" });
}

export function endedPendingDispatch(
  record: PendingDispatch,
  end: PendingDispatchEnd,
): PendingDispatch | null {
  if (TERMINAL_PENDING_DISPATCH_STATES.has(record.state)) return null;
  return { ...record, ...end };
}

async function enqueue(
  args: EnqueuePendingArgs,
  context: MethodContext,
): Promise<MethodResult> {
  const record = startPendingDispatch(
    args,
    await context.readResource!(pendingDataName(args.queueId)),
  );
  const handle = await context.writeResource!(
    "dispatch",
    pendingDataName(args.queueId),
    record,
  );
  return { dataHandles: [handle] };
}

async function writeEnded(
  queueId: string,
  end: PendingDispatchEnd,
  context: MethodContext,
): Promise<MethodResult> {
  const updated = endedPendingDispatch(
    parseStoredPendingDispatch(
      queueId,
      await context.readResource!(pendingDataName(queueId)),
    ),
    end,
  );
  if (updated === null) return { dataHandles: [] };
  const handle = await context.writeResource!(
    "dispatch",
    pendingDataName(queueId),
    updated,
  );
  return { dataHandles: [handle] };
}

const MarkDispatchedArgsSchema = z.object({
  queueId: z.string().min(1),
  dispatchId: z.string().min(1),
  endedAt: z.string().datetime(),
});

function markDispatched(
  args: z.infer<typeof MarkDispatchedArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  return writeEnded(args.queueId, {
    state: "dispatched",
    dispatchId: args.dispatchId,
    endedAt: args.endedAt,
  }, context);
}

const EndPendingArgsSchema = z.object({
  queueId: z.string().min(1),
  endedAt: z.string().datetime(),
});

function endPending(
  state: Extract<PendingDispatchState, "timed_out" | "cancelled" | "orphaned">,
) {
  return (
    args: z.infer<typeof EndPendingArgsSchema>,
    context: MethodContext,
  ): Promise<MethodResult> =>
    writeEnded(args.queueId, { state, endedAt: args.endedAt }, context);
}

export const pendingDispatchModel: ModelDefinition = defineModel({
  type: PENDING_DISPATCH_MODEL_TYPE,
  version: "2026.07.04.1",
  resources: {
    "dispatch": {
      description: "Queued demand record for a step awaiting a worker",
      schema: PendingDispatchSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    enqueue: {
      description: "Record that a step is waiting for a matching worker",
      kind: "create",
      arguments: EnqueueArgsSchema,
      execute: enqueue,
      // serve writes these via PendingDispatchLedger; this bounds direct runs and its fallback
      outputLifetime: "1d",
    },
    mark_dispatched: {
      description: "The step was dispatched to a worker",
      kind: "update",
      arguments: MarkDispatchedArgsSchema,
      execute: markDispatched,
      outputLifetime: "1d",
    },
    timeout: {
      description: "The step timed out waiting for a worker",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("timed_out"),
      outputLifetime: "1d",
    },
    cancel: {
      description: "The step was cancelled while waiting",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("cancelled"),
      outputLifetime: "1d",
    },
    orphan: {
      description: "Boot reconciliation: no matching queue episode found",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("orphaned"),
      outputLifetime: "1d",
    },
  },
});
