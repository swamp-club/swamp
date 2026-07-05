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
 * Built-in worker model (see design/remote-execution.md, "Worker state is
 * swamp data").
 *
 * One model instance per enrolled worker, named by its enrollment-token name.
 * The orchestrator's worker gateway drives these methods inside its
 * serialized critical section — they are not meant for interactive use, but
 * their output is ordinary swamp data: queryable, versioned, and visible to
 * workflows, reports, and the CLI like any model output.
 */

import { z } from "zod";
import { ModelType } from "../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../model.ts";

export const WORKER_MODEL_TYPE = ModelType.create("swamp/worker");

export const WorkerStatusSchema = z.enum([
  "idle",
  "busy",
  "disconnected",
  "unverified",
  "draining",
]);

export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;

export const WorkerStateSchema = z.object({
  name: z.string().describe("Pool-addressable worker name (the token name)"),
  instanceUuid: z.string().describe("Per-instance UUID bound at enrollment"),
  tokenName: z.string().describe("Enrollment token that admitted this worker"),
  status: WorkerStatusSchema,
  labels: z.record(z.string(), z.string()).describe("Scheduling selectors"),
  platform: z.string(),
  arch: z.string(),
  swampVersion: z.string(),
  protocolVersion: z.number().int(),
  enrolledAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().optional(),
  currentDispatchId: z.string().nullable().describe(
    "Dispatch in flight on this worker, or null when idle",
  ),
  verifyFailureReason: z.string().optional().describe(
    "Why the enrollment verification probe failed (present only when status is 'unverified')",
  ),
});

export type WorkerState = z.infer<typeof WorkerStateSchema>;

const STATE_DATA_NAME = "state-main";

async function readState(context: MethodContext): Promise<WorkerState> {
  const raw = await context.readResource!(STATE_DATA_NAME);
  if (raw === null) {
    throw new Error(
      `Worker '${context.definition.name}' has no recorded state — enroll first`,
    );
  }
  return WorkerStateSchema.parse(raw);
}

/** Definition-instance name for a worker (distinct from its token's). */
export function workerDefinitionName(workerName: string): string {
  return `worker-${workerName}`;
}

const EnrollArgsSchema = z.object({
  instanceUuid: z.string().min(1),
  tokenName: z.string().min(1),
  workerName: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()).default({}),
  platform: z.string(),
  arch: z.string(),
  swampVersion: z.string(),
  protocolVersion: z.number().int(),
});

async function enroll(
  args: z.infer<typeof EnrollArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const now = new Date().toISOString();
  const state: WorkerState = {
    name: args.workerName ?? args.tokenName,
    instanceUuid: args.instanceUuid,
    tokenName: args.tokenName,
    status: "idle",
    labels: args.labels,
    platform: args.platform,
    arch: args.arch,
    swampVersion: args.swampVersion,
    protocolVersion: args.protocolVersion,
    enrolledAt: now,
    lastSeenAt: now,
    currentDispatchId: null,
  };
  const handle = await context.writeResource!("state", STATE_DATA_NAME, state);
  return { dataHandles: [handle] };
}

const SetStatusArgsSchema = z.object({
  status: WorkerStatusSchema,
  dispatchId: z.string().optional(),
  verifyFailureReason: z.string().optional(),
});

async function setStatus(
  args: z.infer<typeof SetStatusArgsSchema>,
  context: MethodContext,
): Promise<MethodResult> {
  const current = await readState(context);
  const now = new Date().toISOString();
  const state: WorkerState = {
    ...current,
    status: args.status,
    lastSeenAt: now,
    currentDispatchId: args.status === "busy"
      ? (args.dispatchId ?? null)
      : null,
    ...(args.status === "disconnected" ? { disconnectedAt: now } : {}),
    verifyFailureReason: args.status === "unverified"
      ? args.verifyFailureReason
      : undefined,
  };
  const handle = await context.writeResource!("state", STATE_DATA_NAME, state);
  return { dataHandles: [handle] };
}

/**
 * The worker model definition. Self-registers via the models barrel.
 */
export const workerModel: ModelDefinition = defineModel({
  type: WORKER_MODEL_TYPE,
  version: "2026.07.05.1",
  resources: {
    "state": {
      description:
        "Worker pool membership and status (enrollment, labels, load)",
      schema: WorkerStateSchema,
      lifetime: "infinite",
      // Status flips on every dispatch; keep a bounded recent history so
      // control-plane churn cannot grow the datastore without bound.
      garbageCollection: 20,
    },
  },
  methods: {
    enroll: {
      description: "Record a worker's admission into the pool",
      kind: "create",
      arguments: EnrollArgsSchema,
      execute: enroll,
    },
    set_status: {
      description:
        "Record a worker status change (idle/busy/disconnected/unverified/draining)",
      kind: "update",
      arguments: SetStatusArgsSchema,
      execute: setStatus,
    },
  },
});
