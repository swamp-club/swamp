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
 * Wire protocol for remote execution (see design/enablers/remote-execution.md).
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
 * Version of the remote-execution protocol. Negotiated at enrollment: a
 * worker whose protocol version serve does not support is rejected before
 * any dispatch, never mid-run. Also pins the capability-verb inventory and
 * the sentinel format a dispatch's secret bag is validated against — any
 * change to the verbs below or to `SENTINEL_EXACT` requires a version bump.
 * An optional parameter added to an existing verb does not: a worker that
 * predates it leaves it out, and serve answers the omission as it did
 * before (the `resource` claim on `resolveSecret` is one, swamp-club#3529).
 * Version 5: sentinels carry a 128-bit prefix (swamp-club#3558).
 * Version 6: a dispatch carries vault references only, and the runner
 * loads each value through {@link DISPATCH_SECRETS_PATH} (typed-secrets
 * 5.2, design/enablers/typed-secrets.md Section 9).
 */
export const REMOTE_PROTOCOL_VERSION = 6;

/**
 * The protocol version whose dispatch frame still carries plaintext: the
 * resolved arguments, `secretValues` and the bag entry values. Serve
 * enrolls it for the deprecation window typed-secrets 5.3 ends.
 */
export const LEGACY_PLAINTEXT_PROTOCOL_VERSION = 5;

/** The protocol versions serve enrolls: the current one and the legacy one. */
export const SUPPORTED_REMOTE_PROTOCOL_VERSIONS: readonly number[] = [
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
];

/** Whether serve enrolls a worker that speaks `version`. */
export function isSupportedRemoteProtocolVersion(version: number): boolean {
  return SUPPORTED_REMOTE_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Whether a dispatch to a worker on `version` carries references only, so
 * its runner loads every value through the protected route.
 */
export function shipsReferencesOnly(version: number): boolean {
  return version > LEGACY_PLAINTEXT_PROTOCOL_VERSION;
}

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

// ── Method names ─────────────────────────────────────────────────────────

/**
 * Worker → orchestrator control methods.
 */
export const RemoteMethod = {
  /** First-connect handshake; also re-authenticates the same instance. */
  enroll: "worker.enroll",
  /** Sliding-window refresh of the data-plane session credential. */
  sessionRefresh: "worker.session.refresh",
  /** Worker notifies orchestrator it is draining (no new dispatches). */
  drain: "worker.drain",

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
  labels: boundedRecord(z.string(), z.string()).default({}),
  resourceLimits: z.record(z.string(), z.unknown()).optional(),
  /**
   * Set by a worker without a swamp-club credential, which passes the auth
   * gate on the orchestrator's pass (design/surfaces/auth-gate.md, "Remote
   * workers"). An orchestrator with no pass to give refuses before redeeming
   * the token (`gate_pass_unavailable`), so no enrollment is spent.
   */
  needsGatePass: z.boolean().optional(),
});

export type EnrollParams = z.infer<typeof EnrollParamsSchema>;

export interface EnrollResult {
  workerId: string;
  /** Bearer credential for the HTTP data plane. */
  sessionCredential: string;
  /** Epoch ms when the session credential expires; refresh before this. */
  sessionExpiresAtMs: number;
  protocolVersion: number;
  /**
   * The orchestrator's auth gate pass, `<base64url proof>.<signature>`: the
   * swamp-club signed proof its own pass rests on. Sent only to a worker that
   * set `needsGatePass`, which passes the gate on it. Absent otherwise, and
   * from an orchestrator that predates it.
   */
  gatePass?: string;
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

/** Bounds on a dispatch's `lockHolder`, which a worker writes to an env. */
const MAX_LOCK_HOLDER_HOSTNAME_LENGTH = 255;

/** Longest vault name a load request may name. */
export const MAX_DISPATCH_SECRET_VAULT_NAME_LENGTH = 256;
/** Longest secret key a load request may name. */
export const MAX_DISPATCH_SECRET_KEY_LENGTH = 1024;
/** Longest location a reference entry names, for a load's errors. */
const MAX_DISPATCH_REFERENCE_LOCATION_LENGTH = 4096;

/**
 * A bag entry of a version 6 dispatch: the reference behind a sentinel the
 * step's arguments carry, with no value. The runner loads the value through
 * {@link DISPATCH_SECRETS_PATH} and delivers it in the entry's encoding, as
 * a local run delivers a reference-only entry. `location` names where the
 * reference was written or read from, for a load's errors.
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
 * The stream event a version 6 runner sends once its parse of the step's
 * arguments passed, so serve calls the caller's `onArgumentsValidated`
 * (swamp-club#3681). The runner sends it itself, never inside a
 * `method_event`, so a method's own events cannot pass for it.
 */
export const ARGUMENTS_VALIDATED_EVENT = "arguments_validated";

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
   * for the duration of the step. See design/enablers/remote-execution.md.
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
  /**
   * Resolved vault secret values the worker must register with its
   * SecretRedactor before executing the method body. The orchestrator
   * extracts these from sensitive argument fields; the worker adds them
   * so stdout/stderr redaction catches secrets injected through args.
   * Carried by a version 5 dispatch only, until typed-secrets 5.3 removes
   * it with that version.
   */
  secretValues: z.array(z.string()).optional(),
  /**
   * The step's method args before vault sentinels were resolved. Sent with
   * {@link secretBag} so a worker delivers vault and sensitive data values
   * the way a local run does (to a `command/shell` step as environment
   * variables, never in its command line). `execution.methodArgs` still
   * carries the resolved args, so an older worker that drops both fields
   * runs as before. Absent when the step has no secrets, and from every
   * version 6 dispatch, whose `execution.methodArgs` keep their sentinels.
   */
  unresolvedMethodArgs: z.record(z.string(), z.unknown()).optional(),
  /**
   * The step's vault secret bag entries, with their values; see
   * {@link unresolvedMethodArgs}. A version 5 dispatch only.
   */
  secretBag: z.array(z.object({
    sentinel: z.string().regex(SENTINEL_EXACT),
    value: z.string(),
    dataOrigin: z.boolean(),
    // The value is JSON text a whole-value delivery parses; an older
    // worker drops it and delivers the text.
    jsonValue: z.literal(true).optional(),
  })).optional(),
  /**
   * A version 6 dispatch's bag: one reference-only entry per sentinel its
   * arguments carry, which `execution.globalArgs` and `execution.methodArgs`
   * hold in place. It replaces {@link secretValues}, {@link secretBag} and
   * {@link unresolvedMethodArgs}, which a version 6 dispatch never carries
   * (see {@link plaintextFieldsOf}). Absent when the step holds no secret.
   */
  referenceBag: z.array(DispatchReferenceEntrySchema).optional(),
  /**
   * The per-model locks held for this step's run: the orchestrator's pid
   * and hostname, and the lock-file nonces of the locks it holds for the
   * step and of those handed down to it. The worker hands the nonces to the
   * dispatch runner, so a swamp the step starts skips them
   * (design/enablers/datastores.md, "Parent-Process Lock Awareness").
   * Optional: absent when there are none, and ignored by older workers.
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

/** Most marked error paths a dispatch result may carry. */
export const MAX_ERROR_PATHS = 32;
/** Longest marked error path a dispatch result may carry. */
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

/** Longest error code a dispatch result may carry. */
export const MAX_ERROR_CODE_LENGTH = 128;

/**
 * The code of the `UserError` a dispatch failed with (see `userErrorCode`),
 * or `undefined` when it has none or the code is longer than a dispatch
 * result may carry.
 */
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
   * Filesystem paths the runner's error marked (see `markErrorPaths`), so the
   * orchestrator's telemetry can remove them exactly from `error`
   * (swamp-club#2830). Bounded because a worker supplies it. A value outside
   * the bounds is dropped, never fatal to the result, since these can only
   * add redaction.
   */
  errorPaths: z.array(z.string().max(MAX_ERROR_PATH_LENGTH))
    .max(MAX_ERROR_PATHS)
    .optional()
    .catch(undefined),
  /**
   * The code of the `UserError` the runner's method threw, so the
   * orchestrator rethrows a `UserError` with it and the failed step records
   * it (swamp-club#3773). Bounded because a worker supplies it, and dropped
   * when out of bounds, as `errorPaths` is.
   */
  errorCode: z.string().min(1).max(MAX_ERROR_CODE_LENGTH)
    .optional()
    .catch(undefined),
  outputs: z.array(DispatchOutputSchema),
  logs: z.array(z.string()),
  durationMs: z.number(),
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
  /** True for removeLatestMarker (soft delete) instead of delete. */
  removeLatestMarkerOnly: z.boolean().optional(),
});

export type DeleteDataParams = z.infer<typeof DeleteDataParamsSchema>;

export const ResolveSecretParamsSchema = z.object({
  vaultName: z.string(),
  secretKey: z.string(),
  /** True to fetch the annotation instead of the secret value. */
  annotation: z.boolean().optional(),
  /**
   * A claim that the secret is held by a tagged sensitive field of the
   * dispatch's own resource `name` at `version`. Serve verifies it against
   * the stored record before it answers, and a verified claim admits the
   * read in place of the step's argument allowlist (swamp-club#3529). The
   * worker's resource reader sends it; a method's own vault read does not.
   * Optional: a worker that predates it sends none and is held to the
   * allowlist as before.
   */
  resource: z.object({
    name: z.string().min(1),
    version: z.number().int().positive(),
  }).optional(),
});

export type ResolveSecretParams = z.infer<typeof ResolveSecretParamsSchema>;

// ── Dispatch secret loads (data plane) ───────────────────────────────────

/**
 * The protected data-plane route a runner loads its dispatch's references
 * through (design/enablers/typed-secrets.md Section 9). A data-plane route,
 * not a capability verb; typed-secrets 5.2 raised the version to 6 when
 * workers began calling it.
 */
export const DISPATCH_SECRETS_PATH = "/data/secrets";

/** Most references one load request may name. */
export const MAX_DISPATCH_SECRET_LOADS = 256;
/** Longest resource name a load request's claim may name. */
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
   * A claim that the reference is held by a sensitive field of the
   * dispatch's own resource `name` at `version`, as on `resolveSecret`
   * (swamp-club#3529). The worker's resource reader sends it.
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
