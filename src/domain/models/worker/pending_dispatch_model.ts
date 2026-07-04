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

const TERMINAL_STATES = new Set([
  "dispatched",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export const PendingDispatchStateSchema = z.enum([
  "waiting",
  "dispatched",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export type PendingDispatchState = z.infer<typeof PendingDispatchStateSchema>;

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

async function readPendingDispatch(
  context: MethodContext,
  queueId: string,
): Promise<PendingDispatch> {
  const raw = await context.readResource!(pendingDataName(queueId));
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

async function enqueue(
  args: z.infer<typeof EnqueueArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await context.readResource!(
    pendingDataName(args.queueId),
  );
  if (existing !== null) {
    throw new Error(`Pending dispatch '${args.queueId}' already exists`);
  }
  const record: PendingDispatch = {
    ...args,
    state: "waiting",
  };
  const handle = await context.writeResource!(
    "dispatch",
    pendingDataName(args.queueId),
    record,
  );
  return { dataHandles: [handle] };
}

const MarkDispatchedArgsSchema = z.object({
  queueId: z.string().min(1),
  dispatchId: z.string().min(1),
  endedAt: z.string().datetime(),
});

async function markDispatched(
  args: z.infer<typeof MarkDispatchedArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const record = await readPendingDispatch(context, args.queueId);
  if (TERMINAL_STATES.has(record.state)) {
    return { dataHandles: [] };
  }
  const updated: PendingDispatch = {
    ...record,
    state: "dispatched",
    dispatchId: args.dispatchId,
    endedAt: args.endedAt,
  };
  const handle = await context.writeResource!(
    "dispatch",
    pendingDataName(args.queueId),
    updated,
  );
  return { dataHandles: [handle] };
}

const EndPendingArgsSchema = z.object({
  queueId: z.string().min(1),
  endedAt: z.string().datetime(),
});

function endPending(
  state: Extract<PendingDispatchState, "timed_out" | "cancelled" | "orphaned">,
) {
  return async (
    args: z.infer<typeof EndPendingArgsSchema>,
    context: MethodContext,
  ): Promise<MethodResult> => {
    const record = await readPendingDispatch(context, args.queueId);
    if (TERMINAL_STATES.has(record.state)) {
      return { dataHandles: [] };
    }
    const updated: PendingDispatch = {
      ...record,
      state,
      endedAt: args.endedAt,
    };
    const handle = await context.writeResource!(
      "dispatch",
      pendingDataName(args.queueId),
      updated,
    );
    return { dataHandles: [handle] };
  };
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
    },
    mark_dispatched: {
      description: "The step was dispatched to a worker",
      kind: "update",
      arguments: MarkDispatchedArgsSchema,
      execute: markDispatched,
    },
    timeout: {
      description: "The step timed out waiting for a worker",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("timed_out"),
    },
    cancel: {
      description: "The step was cancelled while waiting",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("cancelled"),
    },
    orphan: {
      description: "Boot reconciliation: no matching queue episode found",
      kind: "update",
      arguments: EndPendingArgsSchema,
      execute: endPending("orphaned"),
    },
  },
});
