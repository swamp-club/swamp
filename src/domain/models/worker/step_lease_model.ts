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
 * Built-in step-lease model (see design/enablers/remote-execution.md).
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

/** Lease states that end a lease; a lease in one of them is never rewritten. */
export const TERMINAL_LEASE_STATES: ReadonlySet<LeaseState> = new Set([
  "completed",
  "failed",
  "expired",
]);

export const StepLeaseSchema = z.object({
  leaseId: z.string(),
  dispatchId: z.string(),
  workerName: z.string(),
  modelType: z.string(),
  modelId: z.string(),
  methodName: z.string(),
  workflowName: z.string().optional(),
  /** The workflow run the step belongs to, when dispatched from a run. */
  workflowRunId: z.string().optional(),
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

/**
 * The stored lease, parsed; throws when the lease does not exist. Shared by
 * the model's methods and serve's lease ledger.
 */
export function parseStoredLease(leaseId: string, raw: unknown): StepLease {
  if (raw === null) {
    throw new Error(`Step lease '${leaseId}' does not exist`);
  }
  return StepLeaseSchema.parse(raw);
}

async function readLease(
  context: MethodContext,
  leaseId: string,
): Promise<StepLease> {
  return parseStoredLease(
    leaseId,
    await context.readResource!(leaseDataName(leaseId)),
  );
}

export const AcquireArgsSchema = z.object({
  leaseId: z.string().min(1),
  dispatchId: z.string().min(1),
  workerName: z.string().min(1),
  modelType: z.string(),
  modelId: z.string(),
  methodName: z.string(),
  workflowName: z.string().optional(),
  workflowRunId: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
});

export type AcquireLeaseArgs = z.infer<typeof AcquireArgsSchema>;

/**
 * The lease `acquire` records: active, with no writes. `existing` is what is
 * stored under the lease's data name; a lease is never acquired twice.
 */
export function startLease(
  args: AcquireLeaseArgs,
  existing: unknown,
  now: Date,
): StepLease {
  if (existing !== null) {
    throw new Error(`Step lease '${args.leaseId}' already exists`);
  }
  return {
    ...args,
    state: "active",
    hasWrites: false,
    createdAt: now.toISOString(),
  };
}

/**
 * The lease with its first durable write recorded, or null when it already
 * records one. Only an active lease records writes.
 */
export function recordLeaseWrites(
  leaseId: string,
  lease: StepLease,
): StepLease | null {
  if (lease.state !== "active") {
    throw new Error(
      `Step lease '${leaseId}' is ${lease.state}; only active leases record writes`,
    );
  }
  if (lease.hasWrites) return null;
  return { ...lease, hasWrites: true };
}

/** The states that end a lease. */
export type EndedLeaseState = Extract<
  LeaseState,
  "completed" | "failed" | "expired"
>;

/** The lease ended in `state`; a lease that already ended is never rewritten. */
export function endedLease(
  leaseId: string,
  lease: StepLease,
  state: EndedLeaseState,
  error: string | undefined,
  now: Date,
): StepLease {
  if (lease.state !== "active") {
    throw new Error(`Step lease '${leaseId}' is already ${lease.state}`);
  }
  return {
    ...lease,
    state,
    endedAt: now.toISOString(),
    ...(error !== undefined ? { error } : {}),
  };
}

async function acquire(
  args: AcquireLeaseArgs,
  context: MethodContext,
): Promise<MethodResult> {
  const lease = startLease(
    args,
    await context.readResource!(leaseDataName(args.leaseId)),
    new Date(),
  );
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
  const marked = recordLeaseWrites(
    args.leaseId,
    await readLease(context, args.leaseId),
  );
  if (marked === null) {
    return { dataHandles: [] };
  }
  const handle = await context.writeResource!(
    "lease",
    leaseDataName(args.leaseId),
    marked,
  );
  return { dataHandles: [handle] };
}

const EndArgsSchema = z.object({
  leaseId: z.string().min(1),
  error: z.string().optional(),
});

function endLease(state: EndedLeaseState) {
  return async (
    args: z.infer<typeof EndArgsSchema>,
    context: MethodContext,
  ): Promise<MethodResult> => {
    const ended = endedLease(
      args.leaseId,
      await readLease(context, args.leaseId),
      state,
      args.error,
      new Date(),
    );
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
