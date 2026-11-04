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
  tokenCreatedAt: z.string().datetime().optional().describe(
    "Mint (createdAt) of the enrollment token this worker is bound to",
  ),
  lastSeenAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().optional(),
  capacity: z.number().int().min(1).default(1).describe(
    "Maximum concurrent dispatch slots advertised at enrollment",
  ),
  activeDispatchIds: z.array(z.string()).default([]).describe(
    "Dispatches currently in flight on this worker",
  ),
  currentDispatchId: z.string().nullable().optional().describe(
    "Deprecated: migration fallback from pre-4b single-dispatch state",
  ),
  verifyFailureReason: z.string().optional().describe(
    "Why the enrollment verification probe failed (present only when status is 'unverified')",
  ),
});

export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const WORKER_STATE_DATA_NAME = "state-main";

export function parseStoredWorkerState(
  definitionName: string,
  raw: Record<string, unknown> | null,
): WorkerState {
  if (raw === null) {
    throw new Error(
      `Worker '${definitionName}' has no recorded state — enroll first`,
    );
  }
  return WorkerStateSchema.parse(raw);
}

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
  capacity: z.number().int().min(1).default(1),
  status: z.enum(["idle", "unverified"]).optional(),
  tokenCreatedAt: z.string().datetime().optional(),
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
    status: args.status ?? "idle",
    labels: args.labels,
    platform: args.platform,
    arch: args.arch,
    swampVersion: args.swampVersion,
    protocolVersion: args.protocolVersion,
    enrolledAt: now,
    ...(args.tokenCreatedAt !== undefined
      ? { tokenCreatedAt: args.tokenCreatedAt }
      : {}),
    lastSeenAt: now,
    capacity: args.capacity,
    activeDispatchIds: [],
  };
  const handle = await context.writeResource!(
    "state",
    WORKER_STATE_DATA_NAME,
    state,
  );
  return { dataHandles: [handle] };
}

export const SetStatusArgsSchema = z.object({
  status: WorkerStatusSchema,
  dispatchId: z.string().optional(),
  activeDispatchIds: z.array(z.string()).optional(),
  verifyFailureReason: z.string().optional(),
  tokenCreatedAt: z.string().datetime().optional(),
});

export type SetStatusArgs = z.infer<typeof SetStatusArgsSchema>;

// the set_status method and serve's WorkerStatusLedger both apply this, so their records match
export function nextWorkerState(
  current: WorkerState,
  args: SetStatusArgs,
  now: Date,
): WorkerState {
  const at = now.toISOString();
  const dispatchIds = args.activeDispatchIds ?? current.activeDispatchIds ?? [];
  return {
    ...current,
    status: args.status,
    lastSeenAt: at,
    activeDispatchIds: args.status === "idle" || args.status === "disconnected"
      ? []
      : dispatchIds,
    ...(args.status === "disconnected" ? { disconnectedAt: at } : {}),
    ...(args.tokenCreatedAt !== undefined
      ? { tokenCreatedAt: args.tokenCreatedAt }
      : {}),
    verifyFailureReason: args.status === "unverified"
      ? args.verifyFailureReason
      : undefined,
  };
}

async function setStatus(
  args: SetStatusArgs,
  context: MethodContext,
): Promise<MethodResult> {
  const current = parseStoredWorkerState(
    context.definition.name,
    await context.readResource!(WORKER_STATE_DATA_NAME),
  );
  const state = nextWorkerState(current, args, new Date());
  const handle = await context.writeResource!(
    "state",
    WORKER_STATE_DATA_NAME,
    state,
  );
  return { dataHandles: [handle] };
}

export const workerModel: ModelDefinition = defineModel({
  type: WORKER_MODEL_TYPE,
  version: "2026.07.06.1",
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
      // serve writes status via WorkerStatusLedger; this bounds direct runs and its fallback
      outputLifetime: "1d",
    },
  },
});
