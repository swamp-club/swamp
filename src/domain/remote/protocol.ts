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
 * Wire protocol for remote execution (see design/remote-execution.md).
 *
 * The control plane is a symmetric request/response protocol carried over the
 * existing serve WebSocket. Frames are distinguished from the legacy client
 * protocol by their `rpc.*` type values, so an ordinary serve client and an
 * enrolling worker can share one listener. Every request carries a
 * caller-assigned `id` echoed on responses, stream events, and errors —
 * the same multiplexing convention as `src/serve/protocol.ts`.
 *
 * Byte-heavy transfers (artifact content, bundles, co-located assets) do NOT
 * ride this protocol — they use the HTTP data plane (`src/serve/data_plane.ts`).
 */

import { z } from "zod";

/**
 * Version of the remote-execution protocol. Negotiated at enrollment: a
 * worker whose protocol version does not match is rejected before any
 * dispatch, never mid-run. Also pins the capability-verb inventory — any
 * change to the verbs below requires a version bump.
 */
export const REMOTE_PROTOCOL_VERSION = 2;

// ── RPC framing ──────────────────────────────────────────────────────────

/** A JSON-safe event streamed for an in-flight request. */
export interface RpcStreamEvent {
  kind: string;
  [key: string]: unknown;
}

/** Error details carried by an `rpc.error` frame. */
export interface RpcErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export type RpcFrame =
  | { type: "rpc.request"; id: string; method: string; params: unknown }
  | { type: "rpc.response"; id: string; result: unknown }
  | { type: "rpc.error"; id: string; error: RpcErrorDetail }
  | { type: "rpc.stream"; id: string; event: RpcStreamEvent }
  | { type: "rpc.cancel"; id: string };

const RpcRequestFrameSchema = z.object({
  type: z.literal("rpc.request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});

const RpcResponseFrameSchema = z.object({
  type: z.literal("rpc.response"),
  id: z.string().min(1),
  result: z.unknown(),
});

const RpcErrorFrameSchema = z.object({
  type: z.literal("rpc.error"),
  id: z.string().min(1),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

const RpcStreamFrameSchema = z.object({
  type: z.literal("rpc.stream"),
  id: z.string().min(1),
  event: z.looseObject({ kind: z.string() }),
});

const RpcCancelFrameSchema = z.object({
  type: z.literal("rpc.cancel"),
  id: z.string().min(1),
});

const RpcFrameSchema = z.discriminatedUnion("type", [
  RpcRequestFrameSchema,
  RpcResponseFrameSchema,
  RpcErrorFrameSchema,
  RpcStreamFrameSchema,
  RpcCancelFrameSchema,
]);

/**
 * Validates a parsed JSON value as an RPC frame. Returns the frame, or null
 * when the value is not an RPC frame at all (e.g. a legacy client message on
 * a shared socket), or a human-readable error string when it is a malformed
 * RPC frame.
 */
export function parseRpcFrame(data: unknown): RpcFrame | string | null {
  if (
    typeof data !== "object" || data === null ||
    typeof (data as { type?: unknown }).type !== "string" ||
    !((data as { type: string }).type.startsWith("rpc."))
  ) {
    return null;
  }
  const result = RpcFrameSchema.safeParse(data);
  if (result.success) {
    return result.data as RpcFrame;
  }
  const issues = result.error.issues.map((i) =>
    `${i.path.join(".")}: ${i.message}`
  ).join("; ");
  return `Invalid RPC frame: ${issues}`;
}

// ── Method names ─────────────────────────────────────────────────────────

/**
 * Worker → orchestrator control methods.
 */
export const RemoteMethod = {
  /** First-connect handshake; also re-authenticates the same instance. */
  enroll: "worker.enroll",
  /** Sliding-window refresh of the data-plane session credential. */
  sessionRefresh: "worker.session.refresh",

  // Capability verbs (metadata half — bytes ride the data plane).
  getData: "capability.getData",
  queryData: "capability.queryData",
  listVersions: "capability.listVersions",
  deleteData: "capability.deleteData",
  resolveSecret: "capability.resolveSecret",
  putSecret: "capability.putSecret",
  readDefinition: "capability.readDefinition",
  readOutput: "capability.readOutput",
  resolveModel: "capability.resolveModel",
} as const;

/**
 * Orchestrator → worker control methods.
 */
export const WorkerMethod = {
  /** Run one execution request; run events stream back on the same id. */
  dispatch: "worker.dispatch",
} as const;

// ── Enrollment ───────────────────────────────────────────────────────────

export const EnrollParamsSchema = z.object({
  /** Enrollment token (named, time-boxed, bound to one machine on first use). */
  token: z.string().min(1),
  /** Per-instance UUID generated at worker startup; in-memory only. */
  instanceUuid: z.string().min(1),
  /**
   * Durable machine identity, persisted in the worker's cache directory. The
   * token binds to this on first redemption so the same machine can re-enroll
   * across restarts. A fresh (temp) cache directory yields a fresh machine id.
   */
  machineId: z.string().min(1),
  protocolVersion: z.number().int(),
  swampVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  /** Scheduling selectors (region, gpu, sandbox tier, ...). */
  labels: z.record(z.string(), z.string()).default({}),
  resourceLimits: z.record(z.string(), z.unknown()).optional(),
});

export type EnrollParams = z.infer<typeof EnrollParamsSchema>;

export interface EnrollResult {
  workerId: string;
  /** Bearer credential for the HTTP data plane. */
  sessionCredential: string;
  /** Epoch ms when the session credential expires; refresh before this. */
  sessionExpiresAtMs: number;
  protocolVersion: number;
}

export interface SessionRefreshResult {
  sessionCredential: string;
  sessionExpiresAtMs: number;
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/**
 * The serializable execution envelope shipped in a dispatch. Mirrors
 * `ExecutionRequest` minus the inline bundle bytes — the worker fetches the
 * bundle by fingerprint over the data plane instead.
 */
export const DispatchExecutionSchema = z.object({
  protocolVersion: z.number().int(),
  modelType: z.string(),
  modelId: z.string(),
  methodName: z.string(),
  globalArgs: z.record(z.string(), z.unknown()),
  methodArgs: z.record(z.string(), z.unknown()),
  definitionMeta: z.object({
    id: z.string(),
    name: z.string(),
    version: z.number(),
    tags: z.record(z.string(), z.string()),
  }),
  resourceSpecs: z.record(z.string(), z.unknown()).optional(),
  fileSpecs: z.record(z.string(), z.unknown()).optional(),
  traceHeaders: z.record(z.string(), z.string()).optional(),
});

export type DispatchExecution = z.infer<typeof DispatchExecutionSchema>;

export const DispatchParamsSchema = z.object({
  /** Unique id for this dispatch; cancel and leases reference it. */
  dispatchId: z.string().min(1),
  /** Step-lease id recorded at the orchestrator. */
  leaseId: z.string().min(1),
  execution: DispatchExecutionSchema,
  /**
   * Content fingerprint of the model bundle to fetch on cache miss, or a
   * `builtin:<type>` sentinel — built-in models ship inside the swamp binary
   * itself (version lockstep is guaranteed at enrollment), so no bundle
   * travels for them.
   */
  bundleFingerprint: z.string().min(1),
  /** Fingerprints of report-provider bundles the step's reports need. */
  reportBundleFingerprints: z.array(z.string()).default([]),
  /**
   * The orchestrator's environment snapshot (identity-denylisted), applied
   * for the duration of the step. See design/remote-execution.md.
   */
  environmentSnapshot: z.record(z.string(), z.string()),
  /**
   * Base URL of the orchestrator's HTTP data plane. Omitted in the common
   * single-listener deployment — the worker derives it from its own connect
   * URL (ws → http, wss → https).
   */
  dataPlaneUrl: z.string().optional(),
  /** Workflow position, for run-event labeling. */
  step: z.object({
    workflowName: z.string().optional(),
    jobName: z.string().optional(),
    stepName: z.string().optional(),
  }).optional(),
  /**
   * Dispatch-level signal for verification probes. When set, the fleet
   * probe model receives this value in its method args to confirm that
   * dispatch-level metadata arrives intact. Travels via DispatchParams
   * rather than the environment snapshot (which denylists SWAMP_* vars).
   */
  probeMarker: z.string().optional(),
});

export type DispatchParams = z.infer<typeof DispatchParamsSchema>;

/**
 * A persisted-output reference in a dispatch result. Workers persist all
 * bytes through the data plane, so outputs always reference durable data.
 */
export const DispatchOutputSchema = z.object({
  dataId: z.string(),
  version: z.number(),
  name: z.string(),
  specName: z.string(),
  type: z.enum(["resource", "file"]),
});

export type DispatchOutput = z.infer<typeof DispatchOutputSchema>;

export const DispatchResultSchema = z.object({
  status: z.enum(["success", "error"]),
  error: z.string().optional(),
  outputs: z.array(DispatchOutputSchema),
  logs: z.array(z.string()),
  durationMs: z.number(),
  /** Serialized follow-up actions; the orchestrator performs them. */
  followUpActions: z.array(z.unknown()).optional(),
});

export type DispatchResult = z.infer<typeof DispatchResultSchema>;

// ── Capability verb payloads (metadata half) ─────────────────────────────

export const GetDataParamsSchema = z.object({
  modelType: z.string(),
  modelId: z.string(),
  /** Name or data id of the artifact. */
  dataName: z.string().optional(),
  dataId: z.string().optional(),
  /** Omitted: resolve `latest` to a concrete version. */
  version: z.number().optional(),
});

export type GetDataParams = z.infer<typeof GetDataParamsSchema>;

/** Metadata answer for getData; bytes are fetched from `contentPath`. */
export interface GetDataResult {
  found: boolean;
  dataId?: string;
  version?: number;
  name?: string;
  contentType?: string;
  size?: number;
  checksum?: string;
  /** Data-plane path for the content bytes (`/data/{type}/{id}/...`). */
  contentPath?: string;
  attributes?: Record<string, unknown>;
}

export const QueryDataParamsSchema = z.object({
  predicate: z.string(),
  options: z.object({
    limit: z.number().optional(),
    select: z.string().optional(),
    loadAttributes: z.boolean().optional(),
  }).optional(),
});

export type QueryDataParams = z.infer<typeof QueryDataParamsSchema>;

export const ListVersionsParamsSchema = z.object({
  modelType: z.string(),
  modelId: z.string(),
  dataName: z.string(),
});

export type ListVersionsParams = z.infer<typeof ListVersionsParamsSchema>;

export const DeleteDataParamsSchema = z.object({
  modelType: z.string(),
  modelId: z.string(),
  dataName: z.string(),
  version: z.number().optional(),
  /** True for removeLatestMarker (soft delete) instead of delete. */
  removeLatestMarkerOnly: z.boolean().optional(),
});

export type DeleteDataParams = z.infer<typeof DeleteDataParamsSchema>;

export const ResolveSecretParamsSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  /** True to fetch the annotation instead of the secret value. */
  annotation: z.boolean().optional(),
});

export type ResolveSecretParams = z.infer<typeof ResolveSecretParamsSchema>;

export const PutSecretParamsSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  /** Present for put; absent for annotation-only operations. */
  secretValue: z.string().optional(),
  /** Present to put an annotation. */
  annotation: z.record(z.string(), z.unknown()).optional(),
  /** True to delete the annotation. */
  deleteAnnotation: z.boolean().optional(),
});

export type PutSecretParams = z.infer<typeof PutSecretParamsSchema>;

export const ReadDefinitionParamsSchema = z.object({
  /** Definition kind (model, workflow, check, report, ...). */
  definitionType: z.string(),
  idOrName: z.string(),
});

export type ReadDefinitionParams = z.infer<typeof ReadDefinitionParamsSchema>;

export const ReadOutputParamsSchema = z.object({
  modelType: z.string(),
  methodName: z.string().optional(),
  outputId: z.string().optional(),
  definitionId: z.string().optional(),
  latestOnly: z.boolean().optional(),
});

export type ReadOutputParams = z.infer<typeof ReadOutputParamsSchema>;

export const ResolveModelParamsSchema = z.object({
  modelIdOrName: z.string(),
});

export type ResolveModelParams = z.infer<typeof ResolveModelParamsSchema>;
