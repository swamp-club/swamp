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
  LOCK_NONCE_PATTERN,
  MAX_LOCK_NONCE_LENGTH,
  MAX_REMOTE_LOCK_IDS,
} from "../datastore/lock_holder_marker.ts";
import { errorPaths, userErrorCode } from "../errors.ts";
import { z } from "zod";
import { boundedRecord } from "../untrusted_parse.ts";
import {
  SECRET_ENCODINGS,
  SENTINEL_EXACT,
} from "../vaults/secret_bag_registry.ts";

/**
 * negotiated at enrollment: an unsupported worker is rejected before any
 * dispatch; changing the verbs or SENTINEL_EXACT needs a bump, an optional
 * parameter on an existing verb does not
 */
export const REMOTE_PROTOCOL_VERSION = 7;

/**
 * this version's dispatch frame still carries plaintext arguments, secretValues
 * and bag values; serve enrolls it only for the deprecation window
 */
export const LEGACY_PLAINTEXT_PROTOCOL_VERSION = 5;

/** 6 still sends queryData and readOutput lists over the control socket */
export const CONTROL_SOCKET_READS_PROTOCOL_VERSION = 6;

export const SUPPORTED_REMOTE_PROTOCOL_VERSIONS: readonly number[] = [
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  CONTROL_SOCKET_READS_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
];

export function isSupportedRemoteProtocolVersion(version: number): boolean {
  return SUPPORTED_REMOTE_PROTOCOL_VERSIONS.includes(version);
}

export function shipsReferencesOnly(version: number): boolean {
  return version > LEGACY_PLAINTEXT_PROTOCOL_VERSION;
}

export interface RpcStreamEvent {
  kind: string;
  [key: string]: unknown;
}

export interface RpcErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export type RpcFrame =
  | {
    type: "rpc.request";
    id: string;
    method: string;
    params: unknown;
    trace?: unknown;
  }
  | { type: "rpc.response"; id: string; result: unknown }
  | { type: "rpc.error"; id: string; error: RpcErrorDetail }
  | { type: "rpc.stream"; id: string; event: RpcStreamEvent }
  | { type: "rpc.cancel"; id: string };

const RpcRequestFrameSchema = z.object({
  type: z.literal("rpc.request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
  trace: z.unknown().optional(),
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
 * null means not an RPC frame (e.g. a legacy client message on the shared
 * socket); a string is the error for a malformed RPC frame
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

/**
 * The enrollment error an orchestrator with no auth gate pass returns to a
 * worker that asked for one (`needsGatePass`). The worker reports it as the
 * gate's block.
 */
export const GATE_PASS_UNAVAILABLE = "gate_pass_unavailable";

/**
 * Enrollment rejection codes that retrying cannot fix: the token is dead or
 * malformed, or the binary speaks another protocol version. A worker stops
 * on these; every other coded rejection is retried.
 */
export const PERMANENT_ENROLLMENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "protocol_mismatch",
  "invalid_token",
  "token_revoked",
  "token_expired",
  "token_mismatch",
  "token_not_found",
  "enrollment_allowance_exhausted",
]);

/**
 * Replaces every quoted name (`'…'`) in an error message, so a token or
 * worker name such as `expired-runners` cannot be mistaken for the reason.
 */
export function withoutQuotedNames(message: string): string {
  return message.replace(/'[^']*'/g, "''");
}

export const RemoteMethod = {
  enroll: "worker.enroll",
  sessionRefresh: "worker.session.refresh",
  drain: "worker.drain",

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

export const WorkerMethod = {
  dispatch: "worker.dispatch",
} as const;

export const EnrollParamsSchema = z.object({
  /** Enrollment token (named, time-boxed, bound to one machine on first use). */
  token: z.string().min(1),
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
  labels: boundedRecord(z.string(), z.string()).default({}),
  resourceLimits: z.record(z.string(), z.unknown()).optional(),
  /**
   * set by a worker with no swamp-club credential, which passes the auth gate
   * on the orchestrator's pass; an orchestrator with none refuses before
   * redeeming the token, so no enrollment is spent
   */
  needsGatePass: z.boolean().optional(),
});

export type EnrollParams = z.infer<typeof EnrollParamsSchema>;

export interface EnrollResult {
  workerId: string;
  sessionCredential: string;
  /** Epoch ms when the session credential expires; refresh before this. */
  sessionExpiresAtMs: number;
  protocolVersion: number;
  /**
   * the orchestrator's auth gate pass; sent only to a worker that set
   * needsGatePass, absent otherwise and from an orchestrator that predates it
   */
  gatePass?: string;
}

export interface SessionRefreshResult {
  sessionCredential: string;
  sessionExpiresAtMs: number;
}

/**
 * mirrors ExecutionRequest minus inline bundle bytes; the worker fetches the
 * bundle by fingerprint over the data plane
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

/** Bounds on a dispatch's `lockHolder`, which a worker writes to an env. */
const MAX_LOCK_HOLDER_HOSTNAME_LENGTH = 255;

export const MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH = 256;
export const MAX_DISPATCH_SECRET_KEY_LENGTH = 1024;
const MAX_DISPATCH_REFERENCE_LOCATION_LENGTH = 4096;

/**
 * a version 6 bag entry: the reference behind a sentinel, with no value; the
 * runner loads it through DISPATCH_SECRETS_PATH; location names where it was
 * written or read, for a load's errors
 */
export const DispatchReferenceEntrySchema = z.object({
  sentinel: z.string().regex(SENTINEL_EXACT),
  reference: z.object({
    vaultName: z.string().min(1).max(MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH),
    key: z.string().min(1).max(MAX_DISPATCH_SECRET_KEY_LENGTH),
  }),
  encoding: z.enum(SECRET_ENCODINGS),
  dataOrigin: z.boolean(),
  // The vault value is JSON text a whole-value delivery parses.
  jsonValue: z.literal(true).optional(),
  location: z.string().max(MAX_DISPATCH_REFERENCE_LOCATION_LENGTH),
});

export type DispatchReferenceEntry = z.infer<
  typeof DispatchReferenceEntrySchema
>;

/**
 * sent by the runner itself once its argument parse passed, never inside a
 * method_event, so a method's own events cannot pass for it
 */
export const ARGUMENTS_VALIDATED_EVENT = "arguments_validated";

export const DispatchParamsSchema = z.object({
  dispatchId: z.string().min(1),
  leaseId: z.string().min(1),
  execution: DispatchExecutionSchema,
  /**
   * content fingerprint of the model bundle to fetch on cache miss, or a
   * builtin:<type> sentinel; built-ins ship in the binary (version lockstep
   * checked at enrollment), so no bundle travels
   */
  bundleFingerprint: z.string().min(1),
  reportBundleFingerprints: z.array(z.string()).default([]),
  environmentSnapshot: z.record(z.string(), z.string()),
  /**
   * omitted in single-listener deployments; the worker derives it from its
   * connect URL (ws to http, wss to https)
   */
  dataPlaneUrl: z.string().optional(),
  step: z.object({
    workflowName: z.string().optional(),
    jobName: z.string().optional(),
    stepName: z.string().optional(),
  }).optional(),
  /**
   * verification probe marker; travels in DispatchParams because the
   * environment snapshot denylists SWAMP_* vars
   */
  probeMarker: z.string().optional(),
  /**
   * resolved vault secret values the worker registers with its SecretRedactor
   * before the method body runs; carried by a version 5 dispatch only
   */
  secretValues: z.array(z.string()).optional(),
  /**
   * method args before sentinel resolution, sent with secretBag so a worker
   * delivers secrets as a local run does (shell env, never command line);
   * absent for version 6 and when no secrets
   */
  unresolvedMethodArgs: z.record(z.string(), z.unknown()).optional(),
  secretBag: z.array(z.object({
    sentinel: z.string().regex(SENTINEL_EXACT),
    value: z.string(),
    dataOrigin: z.boolean(),
    // The value is JSON text a whole-value delivery parses; an older
    // worker drops it and delivers the text.
    jsonValue: z.literal(true).optional(),
  })).optional(),
  /**
   * a version 6 bag: one reference-only entry per sentinel the arguments hold
   * in place; replaces secretValues, secretBag and unresolvedMethodArgs, which
   * a version 6 dispatch never carries
   */
  referenceBag: z.array(DispatchReferenceEntrySchema).optional(),
  /**
   * per-model locks held for this step (pid, hostname, lock nonces) handed to
   * the runner so a swamp the step starts skips them; absent when none, ignored
   * by older workers
   */
  lockHolder: z.object({
    pid: z.number().int().positive().safe(),
    hostname: z.string().min(1).max(MAX_LOCK_HOLDER_HOSTNAME_LENGTH),
    lockIds: z.array(
      z.string().max(MAX_LOCK_NONCE_LENGTH).regex(LOCK_NONCE_PATTERN),
    ).max(MAX_REMOTE_LOCK_IDS),
  }).optional(),
});

export type DispatchParams = z.infer<typeof DispatchParamsSchema>;

/**
 * The plaintext-bearing fields a dispatch carries, by name. A dispatch whose
 * `execution.protocolVersion` ships references only must carry none of
 * them, and a runner refuses one that does before it reads any.
 */
export function plaintextFieldsOf(params: DispatchParams): string[] {
  const fields: string[] = [];
  if (params.secretValues !== undefined) fields.push("secretValues");
  if (params.secretBag !== undefined) fields.push("secretBag");
  if (params.unresolvedMethodArgs !== undefined) {
    fields.push("unresolvedMethodArgs");
  }
  return fields;
}

export const DispatchOutputSchema = z.object({
  dataId: z.string(),
  version: z.number(),
  name: z.string(),
  specName: z.string(),
  type: z.enum(["resource", "file"]),
});

export type DispatchOutput = z.infer<typeof DispatchOutputSchema>;

export const MAX_ERROR_PATHS = 32;
export const MAX_ERROR_PATH_LENGTH = 4096;

/**
 * The paths an error marked, trimmed to what a dispatch result may carry, or
 * `undefined` when there are none. The runner sends this so the orchestrator
 * never has to drop the whole list for being out of bounds.
 */
export function dispatchErrorPaths(error: unknown): string[] | undefined {
  const paths = errorPaths(error)
    .filter((path) => path.length <= MAX_ERROR_PATH_LENGTH)
    .slice(0, MAX_ERROR_PATHS);
  return paths.length > 0 ? paths : undefined;
}

export const MAX_ERROR_CODE_LENGTH = 128;

export function dispatchErrorCode(error: unknown): string | undefined {
  const code = userErrorCode(error);
  return code !== undefined && code.length <= MAX_ERROR_CODE_LENGTH
    ? code
    : undefined;
}

export const DispatchResultSchema = z.object({
  trace: z.unknown().optional(),
  status: z.enum(["success", "error"]),
  error: z.string().optional(),
  /**
   * filesystem paths the runner's error marked, so telemetry can remove them
   * exactly; bounded because a worker supplies it, and dropped rather than
   * fatal when out of bounds, since they only add redaction
   */
  errorPaths: z.array(z.string().max(MAX_ERROR_PATH_LENGTH))
    .max(MAX_ERROR_PATHS)
    .optional()
    .catch(undefined),
  /**
   * the UserError code the method threw, so the orchestrator rethrows with it;
   * bounded because a worker supplies it, and dropped when out of bounds, as
   * errorPaths is
   */
  errorCode: z.string().min(1).max(MAX_ERROR_CODE_LENGTH)
    .optional()
    .catch(undefined),
  outputs: z.array(DispatchOutputSchema),
  logs: z.array(z.string()),
  durationMs: z.number(),
});

export type DispatchResult = z.infer<typeof DispatchResultSchema>;

export const GetDataParamsSchema = z.object({
  modelType: z.string(),
  modelId: z.string(),
  dataName: z.string().optional(),
  dataId: z.string().optional(),
  /** Omitted: resolve `latest` to a concrete version. */
  version: z.number().optional(),
});

export type GetDataParams = z.infer<typeof GetDataParamsSchema>;

export interface GetDataResult {
  found: boolean;
  dataId?: string;
  version?: number;
  name?: string;
  contentType?: string;
  size?: number;
  checksum?: string;
  contentPath?: string;
  attributes?: Record<string, unknown>;
  tags?: Record<string, string>;
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
  removeLatestMarkerOnly: z.boolean().optional(),
});

export type DeleteDataParams = z.infer<typeof DeleteDataParamsSchema>;

export const ResolveSecretParamsSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  annotation: z.boolean().optional(),
  /**
   * claim that a tagged sensitive field of the dispatch's own resource name at
   * version holds the secret; serve verifies it against the stored record, and
   * a verified claim admits the read in place of the allowlist
   */
  resource: z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
  }).optional(),
});

export type ResolveSecretParams = z.infer<typeof ResolveSecretParamsSchema>;

/**
 * the protected data-plane route a runner loads its dispatch's references
 * through; a data-plane route, not a capability verb
 */
export const DISPATCH_SECRETS_PATH = "/data/secrets";

/**
 * data-plane routes for the reads whose replies can outgrow a control frame;
 * a reply streams one `{"item": ...}` line per record, then `{"count": n}`
 */
export const WORKER_QUERY_PATH = "/data/query";
export const WORKER_OUTPUTS_PATH = "/data/outputs";

export const MAX_WORKER_READ_BODY_BYTES = 64 * 1024;

export const MAX_DISPATCH_SECRET_LOADS = 256;
export const MAX_DISPATCH_SECRET_RESOURCE_NAME_LENGTH = 512;
/**
 * Most distinct resources (name and version) one load request may claim.
 * Each is a record read serve verifies, so the cap bounds that work and
 * keeps one request from emptying the bounded claim cache.
 */
export const MAX_DISPATCH_SECRET_CLAIMS = 16;
/**
 * Largest load request body serve reads. Fits
 * {@link MAX_DISPATCH_SECRET_LOADS} references at the longest names, each
 * with a resource claim, so a request the schema admits is never refused
 * for its size.
 */
export const MAX_DISPATCH_SECRET_LOAD_BODY_BYTES = 4 * 1024 * 1024;

export const DispatchSecretLoadReferenceSchema = z.object({
  vaultName: z.string().min(1).max(MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH),
  key: z.string().min(1).max(MAX_DISPATCH_SECRET_KEY_LENGTH),
  /**
   * claim that a sensitive field of the dispatch's own resource name at version
   * holds the reference, as on resolveSecret
   */
  resource: z.object({
    name: z.string().min(1).max(MAX_DISPATCH_SECRET_RESOURCE_NAME_LENGTH),
    version: z.number().int().positive(),
  }).strict().optional(),
}).strict();

export type DispatchSecretLoadReference = z.infer<
  typeof DispatchSecretLoadReferenceSchema
>;

export const DispatchSecretLoadRequestSchema = z.object({
  references: z.array(DispatchSecretLoadReferenceSchema).min(1).max(
    MAX_DISPATCH_SECRET_LOADS,
  ).refine(
    (references) =>
      new Set(
        references.flatMap((ref) =>
          ref.resource
            ? [`${ref.resource.name}\u0000${ref.resource.version}`]
            : []
        ),
      ).size <= MAX_DISPATCH_SECRET_CLAIMS,
    { message: `claims more than ${MAX_DISPATCH_SECRET_CLAIMS} resources` },
  ),
}).strict();

export type DispatchSecretLoadRequest = z.infer<
  typeof DispatchSecretLoadRequestSchema
>;

export const DispatchSecretLoadResponseSchema = z.object({
  /** One value per distinct reference, in order of first occurrence. */
  values: z.array(
    z.object({
      vaultName: z.string(),
      key: z.string(),
      value: z.string(),
    }).strict(),
  ),
}).strict();

export type DispatchSecretLoadResponse = z.infer<
  typeof DispatchSecretLoadResponseSchema
>;

/**
 * Why serve refused a load. A refusal body carries the code and, when one
 * reference caused it, that reference; never a value.
 */
export const DISPATCH_SECRET_LOAD_REFUSALS = [
  "unauthenticated",
  "malformed_request",
  "request_too_large",
  "reserved_secret",
  "not_in_dispatch",
  "resource_claim_refused",
  "vault_access_denied",
  "secret_not_found",
  "vault_error",
  "access_ended",
  "audit_unavailable",
  "internal_error",
] as const;

export type DispatchSecretLoadRefusal =
  typeof DISPATCH_SECRET_LOAD_REFUSALS[number];

export const DispatchSecretLoadRefusalSchema = z.object({
  error: z.string(),
  code: z.enum(DISPATCH_SECRET_LOAD_REFUSALS),
  reference: z.object({ vaultName: z.string(), key: z.string() }).optional(),
}).strict();

export type DispatchSecretLoadRefusalBody = z.infer<
  typeof DispatchSecretLoadRefusalSchema
>;

export const PutSecretParamsSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  secretValue: z.string().optional(),
  annotation: z.record(z.string(), z.unknown()).optional(),
  deleteAnnotation: z.boolean().optional(),
});

export type PutSecretParams = z.infer<typeof PutSecretParamsSchema>;

export const ReadDefinitionParamsSchema = z.object({
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

/** a declared extension asset the orchestrator did not ship, and why */
export interface WithheldAsset {
  relPath: string;
  field: "additionalFiles" | "binaries";
  reason:
    | "missing"
    | "a symlink"
    | "not a regular file"
    | "outside the extension directory";
}
