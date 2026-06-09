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

/**
 * Built-in step-lease model (see design/remote-execution.md).
 *
 * A lease records that a given step is in flight on a given worker, and
 * whether it has performed any durable write — the fact that decides the
 * failure semantics when a worker drops: no-write leases re-dispatch,
 * write-bearing leases fail the run.
 *
 * Unlike workers and tokens, leases are high-churn: all leases live as
 * separately named data items under a single model instance (`leases`), so
 * dispatch does not mint a new model definition per step.
 */

import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

export const STEP_LEASE_MODEL_TYPE = ModelType.create("swamp/step-lease");

/** The single model-instance name under which all leases are recorded. */
export const STEP_LEASE_INSTANCE_NAME = "leases";

export const LeaseStateSchema = z.enum([
  "active",
  "completed",
  "failed",
  "expired",
]);

export type LeaseState = z.infer<typeof LeaseStateSchema>;

export const StepLeaseSchema = z.object({
  leaseId: z.string(),
  dispatchId: z.string(),
  workerName: z.string(),
  modelType: z.string(),
  modelId: z.string(),
  methodName: z.string(),
  workflowName: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
  state: LeaseStateSchema,
  /** True once the dispatched step performed any durable write. */
  hasWrites: z.boolean(),
  createdAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export type StepLease = z.infer<typeof StepLeaseSchema>;

export function leaseDataName(leaseId: string): string {
  return `lease-${leaseId}`;
}

async function readLease(
  context: MethodContext,
  leaseId: string,
): Promise<StepLease> {
  const raw = await context.readResource!(leaseDataName(leaseId));
  if (raw === null) {
    throw new Error(`Step lease '${leaseId}' does not exist`);
  }
  return StepLeaseSchema.parse(raw);
}

const AcquireArgsSchema = z.object({
  leaseId: z.string().min(1),
  dispatchId: z.string().min(1),
  workerName: z.string().min(1),
  modelType: z.string(),
  modelId: z.string(),
  methodName: z.string(),
  workflowName: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
});

async function acquire(
  args: z.infer<typeof AcquireArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const existing = await context.readResource!(leaseDataName(args.leaseId));
  if (existing !== null) {
    throw new Error(`Step lease '${args.leaseId}' already exists`);
  }
  const lease: StepLease = {
    ...args,
    state: "active",
    hasWrites: false,
    createdAt: new Date().toISOString(),
  };
  const handle = await context.writeResource!(
    "lease",
    leaseDataName(args.leaseId),
    lease,
  );
  return { dataHandles: [handle] };
}

const LeaseIdArgsSchema = z.object({
  leaseId: z.string().min(1),
});

async function markWrites(
  args: z.infer<typeof LeaseIdArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const lease = await readLease(context, args.leaseId);
  if (lease.state !== "active") {
    throw new Error(
      `Step lease '${args.leaseId}' is ${lease.state}; only active leases record writes`,
    );
  }
  if (lease.hasWrites) {
    return { dataHandles: [] };
  }
  const handle = await context.writeResource!(
    "lease",
    leaseDataName(args.leaseId),
    { ...lease, hasWrites: true },
  );
  return { dataHandles: [handle] };
}

const EndArgsSchema = z.object({
  leaseId: z.string().min(1),
  error: z.string().optional(),
});

function endLease(
  state: Extract<LeaseState, "completed" | "failed" | "expired">,
) {
  return async (
    args: z.infer<typeof EndArgsSchema>,
    context: MethodContext,
  ): Promise<MethodResult> => {
    const lease = await readLease(context, args.leaseId);
    if (lease.state !== "active") {
      throw new Error(
        `Step lease '${args.leaseId}' is already ${lease.state}`,
      );
    }
    const ended: StepLease = {
      ...lease,
      state,
      endedAt: new Date().toISOString(),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
    const handle = await context.writeResource!(
      "lease",
      leaseDataName(args.leaseId),
      ended,
    );
    return { dataHandles: [handle] };
  };
}

/**
 * The step-lease model definition. Self-registers via the models barrel.
 */
export const stepLeaseModel: ModelDefinition = defineModel({
  type: STEP_LEASE_MODEL_TYPE,
  version: "2026.06.09.1",
  resources: {
    "lease": {
      description: "In-flight dispatch record for a step on a worker",
      schema: StepLeaseSchema,
      lifetime: "infinite",
      // A lease's full history is short (acquire → writes? → end); keep it
      // all, but the per-name version count stays bounded by construction.
      garbageCollection: 10,
    },
  },
  methods: {
    acquire: {
      description: "Record that a step is in flight on a worker",
      kind: "create",
      arguments: AcquireArgsSchema,
      execute: acquire,
    },
    mark_writes: {
      description: "Record the lease's first durable write",
      kind: "update",
      arguments: LeaseIdArgsSchema,
      execute: markWrites,
    },
    complete: {
      description: "End the lease: the step finished successfully",
      kind: "update",
      arguments: EndArgsSchema,
      execute: endLease("completed"),
    },
    fail: {
      description: "End the lease: the step failed",
      kind: "update",
      arguments: EndArgsSchema,
      execute: endLease("failed"),
    },
    expire: {
      description:
        "End the lease: the worker dropped and the grace window elapsed",
      kind: "update",
      arguments: EndArgsSchema,
      execute: endLease("expired"),
    },
  },
});
