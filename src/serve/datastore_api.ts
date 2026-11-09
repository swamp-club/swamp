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
 * Serve's datastore API (swamp-club#3915): the HTTP routes through which a
 * team's laptops and CI write a v3 datastore that serve holds the writer
 * lease of, with a serve token instead of storage credentials. Under
 * `/api/v1/datastore/{namespace}/`, where the namespace is the datastore's
 * storage namespace (`_default` when it has none):
 *
 * | Route | |
 * |---|---|
 * | `POST chunks/has` | `{hashes}`: the ones serve holds that the caller may reference, touched for GC |
 * | `PUT chunks/{sha256}` | one chunk, to resume a large upload |
 * | `GET chunks/{sha256}` | a chunk's bytes, with `Range` |
 * | `POST partitions/{p}/commits` | one commit and its missing chunks, framed: `{seq}` or a conflict |
 * | `GET partitions/{p}/commits?after=&held=` | a partition's commits after a seq; a follower behind `held`, the seq the caller's copy holds, refuses as behind |
 * | `GET changes?cursor=` | every commit since a cursor the caller may read |
 * | `GET base?after=` | the compacted base, a page at a time, filtered to what the caller may read |
 * | `POST locks` | take serve's model or workflow-run lock for the caller: a lease |
 * | `PUT locks/{leaseId}` | renew a lease |
 * | `DELETE locks/{leaseId}` | release a lease |
 * | `DELETE locks` | `{lockKey}`: end the lease on a lock whoever holds it; admin |
 * | `POST quarantine` | keep a change serve refuses for a grant its author lacks |
 * | `POST quarantine/{txnId}/accept` | land a kept change, as its author; admin |
 *
 * Every commit is authorised op by op on its intents
 * ({@link authorizeCommit}), its chunks are hashed as they arrive, the
 * caller is stamped as its principal, and serve's own writer commits it.
 * See "Team mode: serve's datastore API" in `design/enablers/datastores.md`.
 *
 * @module
 */

import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { unresolvedAccessResource } from "../domain/access/access_resources.ts";
import type { Action } from "../domain/access/action.ts";
import {
  parsePrincipal,
  principalToString,
} from "../domain/access/principal.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../domain/data/namespace.ts";
import {
  setActiveSpanAttributes,
  type Span,
  withRootSpan,
  withSpan,
} from "../infrastructure/tracing/tracer.ts";
import { adoptAuthenticatedParent } from "../infrastructure/tracing/adopted_parent.ts";
import { withHttpServerSpan } from "./http_request_span.ts";
import type { BlobRef } from "../domain/datastore_v3/blob_ref.ts";
import { Commit, MAX_COMMIT_OPS } from "../domain/datastore_v3/commit.ts";
import {
  ADMIN_RESOURCE,
  type AggregateResourceResolver,
  authorizeCommit,
  baseDataReadAccessOf,
  baseRecordReadAccessOf,
  type CallerAuthority,
  type CommitRefusal,
  definitionRecordReadAccessOf,
  partitionReadAccessOf,
  partitionWriteAccessOf,
  type RequiredAccess,
  RUN_INITIATOR_MISMATCH_REASON,
} from "../domain/datastore_v3/commit_authorization.ts";
import { storageNamespaceOf } from "../domain/datastore_v3/chunk_store.ts";
import {
  CommitsCompactedError,
  type CompactedBaseEntry,
  InvalidBasePageTokenError,
} from "../domain/datastore_v3/commit_store.ts";
import {
  type ObservedBaseEntry,
  observedBaseEntryToJSON,
} from "../domain/datastore_v3/observed_base.ts";
import {
  type LeaseOp,
  leaseOp,
  type Op,
  opFromJSON,
} from "../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../domain/datastore_v3/partition.ts";
import {
  baseOf as quarantineBaseOf,
  boundedQuarantineReason,
  carriesExactly as quarantineCarriesExactly,
  chunksOf as quarantineChunksOf,
  isQuarantineTxnId,
  MAX_QUARANTINE_DEPOSIT_BYTES,
  MAX_RECORDED_MEMBERSHIPS,
  principalKeyOf,
  type QuarantineChunk,
  quarantineHasRoom,
  type QuarantineRecord,
  type QuarantineStore,
} from "../domain/datastore_v3/quarantine.ts";
import type { DataMetadata } from "../domain/data/data_metadata.ts";
import { resolveActorIdentity } from "../domain/serve_audit/actor_identity.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  flushOfflineEntries,
  type OfflineFlushPort,
  type OfflineFlushReport,
} from "../infrastructure/datastore_v3/offline_flush.ts";
import {
  ServeCommitRefusedError,
  ServeUpstreamError,
} from "../infrastructure/datastore_v3/serve_upstream_errors.ts";
import {
  PartitionKey,
  partitionOf,
} from "../domain/datastore_v3/partition_key.ts";
import { ReadModelIncompleteError } from "../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import {
  isControlPlaneModelType,
  isDelegationModelType,
  isIntegrationModelType,
} from "../domain/models/control_plane_types.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { createWorkflowRunId } from "../domain/workflows/workflow_id.ts";
import type { YamlWorkflowRunRepository } from "../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  ChunkIngestError,
  chunkReadResponse,
  FramedReader,
  ingestChunk,
  isSha256Hex,
  parseRange,
  type VerifiedChunk,
} from "../infrastructure/datastore_v3/chunk_ingest.ts";
import { CarriedBytesBudget } from "./carried_bytes_budget.ts";
import {
  ChunksMissingError,
  commitForwarded,
  type ForwardedCommitResult,
  landedForwardedCommit,
  PreconditionConflictError,
  StaleSeqError,
  TxnIdReusedError,
} from "../infrastructure/datastore_v3/forwarded_commit.ts";
import type {
  UploadLedger,
  UploadReservation,
} from "../infrastructure/datastore_v3/upload_ledger.ts";
import {
  AUTHORIZE_ONLY_FEATURE,
  COMMIT_BATCH_FEATURE,
  LEASE_HOLDER_FEATURE,
  LEASE_OPS_FEATURE,
  MAX_BATCH_COMMITS,
  RUN_INITIATOR_FEATURE,
  SERVE_DATASTORE_ACCESS_HEADER,
  SERVE_DATASTORE_FEATURES_HEADER,
  SERVE_DATASTORE_LOG_HEADER,
  SERVE_DATASTORE_PRINCIPAL_HEADER,
  STEP_STARTS_FEATURE,
} from "../infrastructure/datastore_v3/serve_datastore_client.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isCallerAuthorized,
  isCallerAuthorizedForAll,
  refuseIntegrationCaller,
  replicationErrorForClient,
  resolveDisplayPrincipal,
} from "./handlers/shared.ts";
import {
  commitJSONFor,
  commitReadAccessOf,
  memoized,
  type ReaderFeatures,
  serveResolver,
} from "./commit_read_filter.ts";
import {
  authenticateHttpCaller,
  type HttpCaller,
  httpFailure,
  tooManyRequests,
} from "./http_caller_auth.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";
import type { DatastoreRoute } from "./datastore_routes.ts";
import { ForwardedContentAuthority } from "./forwarded_content_authorization.ts";
import {
  type DatastoreLockLeases,
  DEFAULT_LOCK_TTL_MS,
  type LeaseBase,
  type LeaseHolder,
  LeaseRecordNotRemovedError,
  type LeaseView,
  type LockHolder,
  lockKeyOf,
  type LockTarget,
  lockTargetOfPartition,
  parseLockKey,
} from "./datastore_locks.ts";
import { LEASE_RECORD_NOT_REMOVED_CODE } from "../domain/datastore_v3/persisted_lease.ts";
import { ServeNotLeaderError } from "../domain/datastore_v3/serve_leader.ts";
import { followerBehindResponse, notLeaderResponse } from "./leader_link.ts";

const logger = getSwampLogger(["serve", "datastore-api"]);

/** The most leases one `GET locks` lists (swamp-club#4121). */
export const MAX_LISTED_LEASES = 512;

/** The largest commit envelope, before it is parsed. */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
/** The most chunks one commit request carries. */
export const MAX_CHUNKS_PER_COMMIT = 1024;
/** The largest commit request body: envelope and chunks. */
export const MAX_COMMIT_BODY_BYTES = 1024 * 1024 * 1024;
/**
 * The largest quarantine deposit request: its chunks, base64 in JSON, and
 * its commit (swamp-club#4195).
 */
export const MAX_QUARANTINE_REQUEST_BYTES =
  Math.ceil(MAX_QUARANTINE_DEPOSIT_BYTES / 3) * 4 + MAX_ENVELOPE_BYTES;
/** The most hashes one `chunks/has` asks about. */
export const MAX_HAS_HASHES = 1024;
/** The largest page of commits or changes. */
export const MAX_PAGE = 1000;
/** The most feed rows one changes request scans, kept or filtered. */
export const MAX_CHANGES_SCAN = 10_000;
/** The most compacted base entries one base request scans, kept or filtered. */
export const MAX_BASE_SCAN = 10_000;
/** The referencing partitions a chunk read fetches at a time. */
const REFERENCING_PARTITIONS_PAGE = 64;
/** The definition commits a chunk read fetches at a time. */
const DEFINITION_COMMITS_PAGE = 100;
/**
 * The most referencing partitions one request checks the caller against,
 * over every chunk it asks about (swamp-club#4260).
 */
export const MAX_VOUCH_PARTITIONS = 1024;
/**
 * The most behavior definition commits one request reads to vouch for
 * chunks, over every chunk it asks about (swamp-club#4260).
 */
export const MAX_VOUCH_COMMITS = 10_000;

/**
 * Whether a partition the caller may read vouches for a chunk: `undecided`
 * when the request's budget ran out first (swamp-club#4260).
 */
type Vouch = "vouched" | "refused" | "undecided";

/**
 * The work one request may spend deciding which chunks the caller may
 * reference, shared by every chunk it asks about, so a `chunks/has` of
 * {@link MAX_HAS_HASHES} hashes is bounded per request, not per hash.
 */
export class VouchBudget {
  #partitions: number;
  #commits: number;

  constructor(
    partitions: number = MAX_VOUCH_PARTITIONS,
    commits: number = MAX_VOUCH_COMMITS,
  ) {
    this.#partitions = partitions;
    this.#commits = commits;
  }

  /** Spends one partition check; false once none is left. */
  spendPartition(): boolean {
    if (this.#partitions <= 0) return false;
    this.#partitions--;
    return true;
  }

  /** The definition commit reads left. */
  get commitsLeft(): number {
    return this.#commits;
  }

  /** Spends one definition commit read; false once none is left. */
  spendCommit(): boolean {
    if (this.#commits <= 0) return false;
    this.#commits--;
    return true;
  }
}
/** The most chunk requests one principal has in flight. */
export const MAX_CONCURRENT_CHUNK_REQUESTS = 8;

/** The most of one request's carried chunks being stored at once. */
export const CARRIED_PUT_CONCURRENCY = 4;

/** what one principal's chunk requests held when each read one at a time */
export const CARRIED_BYTES_IN_FLIGHT_BUDGET = 128 * 1024 * 1024;

const carriedBytesBudget = new CarriedBytesBudget(
  CARRIED_BYTES_IN_FLIGHT_BUDGET,
);

export function carriedBytesInFlightForTesting(): number {
  return carriedBytesBudget.used;
}

// a declared size ingestChunk will refuse still waits no longer than the budget
function budgetedBytesOf(size: number): number {
  return Number.isSafeInteger(size) && size > 0
    ? Math.min(size, CARRIED_BYTES_IN_FLIGHT_BUDGET)
    : 0;
}

/**
 * A chunk read refused because whether the caller may read it could not be
 * decided within the request's limits (swamp-club#4260): not an answer
 * that the chunk is missing.
 */
export const CHUNK_ACCESS_UNDECIDED_CODE = "chunk_access_undecided";

export interface DatastoreApiDeps {
  readonly ctx: ConnectionContext;
  /** Serve's v3 datastore; undefined when the datastore is not v3. */
  readonly v3: V3Datastore | undefined;
  /** Authenticates a bearer token. Not called when authorization is off. */
  readonly authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
  readonly ledger: UploadLedger;
  /** The model and workflow-run locks serve holds for callers. */
  readonly locks: DatastoreLockLeases;
  /**
   * Where changes refused for a grant their author lacks are kept for an
   * admin (swamp-club#4195); absent when serve keeps none.
   */
  readonly quarantine?: QuarantineStore;
  readonly now?: () => number;
  /**
   * The budget each decision of which chunks a caller may reference gets
   * (swamp-club#4260), in place of the one {@link vouchLimits} sizes.
   */
  readonly vouchBudget?: () => VouchBudget;
  /**
   * A request's vouch limits, {@link MAX_VOUCH_PARTITIONS} and
   * {@link MAX_VOUCH_COMMITS} when absent. A commit's possession checks get
   * at least {@link REFERENCING_PARTITIONS_PAGE} partition checks per chunk
   * it does not carry on top.
   */
  readonly vouchLimits?: {
    readonly partitions: number;
    readonly commits: number;
  };
}

type ApiCaller = HttpCaller;

/** Chunk requests in flight, by principal. */
const chunkRequestsInFlight = new Map<string, number>();

/** Catches serve's checkout up once per batch of commits that landed. */
const catchUps = new WeakMap<V3Datastore, CatchUpCoalescer>();

/**
 * Answers a request {@link matchDatastoreRoute} matched. The caller is
 * authenticated and rate-limited before anything else, and a body is read
 * only once the request is authorised. Every reply to an authenticated
 * caller of a v3 datastore carries the log's id
 * ({@link SERVE_DATASTORE_LOG_HEADER}): a checkout's copy refuses a serve
 * that answers with another log's (swamp-club#4049). It says nothing of
 * the log's content, so it goes to every authenticated caller, whatever
 * its grants. Every reply to an authenticated caller also carries a
 * fingerprint of what the caller may read
 * ({@link SERVE_DATASTORE_ACCESS_HEADER}): a checkout's copy is rebuilt
 * when it changes, so a widened or narrowed grant refreshes what the copy
 * holds (swamp-club#4089).
 */
export async function handleDatastoreRequest(
  req: Request,
  route: DatastoreRoute,
  sourceIp: string,
  deps: DatastoreApiDeps,
): Promise<Response> {
  const arrived = performance.timeOrigin + performance.now();
  // in serve's own trace: the caller's is adopted only once this passes
  let authSpan: Span | undefined;
  const authenticated = await withRootSpan(
    "swamp.serve.datastore.authenticate",
    {},
    (span) => {
      authSpan = span;
      return authenticateHttpCaller(req, sourceIp, {
        authMode: deps.ctx.authConfig.mode,
        authenticate: deps.authenticate,
        now: deps.now,
      });
    },
  );
  const authMs = performance.timeOrigin + performance.now() - arrived;
  const links = authSpan === undefined
    ? []
    : [{ context: authSpan.spanContext() }];
  if (authenticated instanceof Response) {
    return await withHttpServerSpan(req, () => authenticated, {
      startTime: arrived,
      links,
    });
  }
  return await withHttpServerSpan(
    req,
    () => {
      setActiveSpanAttributes({ "swamp.serve.auth_ms": Math.round(authMs) });
      return answerAuthenticated(req, route, sourceIp, deps, authenticated);
    },
    {
      startTime: arrived,
      links,
      // auth mode none authenticates nobody, so no caller picks the trace
      parent: deps.ctx.authConfig.mode === "none"
        ? undefined
        : adoptAuthenticatedParent(req.headers),
    },
  );
}

function integrationRefusedResponse(): Response {
  return Response.json({
    status: "error",
    code: "forbidden",
    message: "An integration token can't use the datastore API",
  }, { status: 403 });
}

async function answerAuthenticated(
  req: Request,
  route: DatastoreRoute,
  sourceIp: string,
  deps: DatastoreApiDeps,
  authenticated: ApiCaller,
): Promise<Response> {
  if (
    refuseIntegrationCaller(
      authenticated.access,
      crypto.randomUUID(),
      "datastore-api",
      deps.ctx,
    )
  ) {
    return integrationRefusedResponse();
  }
  // A follower in team mode passes a write on to the leader with the
  // caller's own credentials (swamp-club#4120), and answers reads only
  // while its copy is fresh (swamp-club#4096); after authentication, so
  // only a caller reaches the leader through it or learns which node leads.
  const notLeader = followerDatastoreRefusal(req, route, sourceIp, deps.ctx);
  if (notLeader !== undefined) return await notLeader;
  // A leader adopting the explicit leases its predecessor kept lists none
  // until it has (swamp-club#4195): the listing would leave out the leases
  // not adopted yet. Each write waits only on its own key (swamp-club#4258).
  if (
    deps.locks.adopting && route.kind === "locks" && req.method === "GET"
  ) {
    return adoptionPendingResponse();
  }
  // Taken before the reply is answered: a reload while it is answered then
  // shows as a change on the next reply, which rebuilds the copy, never as
  // the access a copy filtered under the old grants was built with.
  const access = callerReadAccess(authenticated, deps.ctx);
  const response = await answerDatastoreRequest(
    req,
    route,
    authenticated,
    deps,
  );
  const headers: [string, string][] = access === undefined
    ? []
    : [[SERVE_DATASTORE_ACCESS_HEADER, access]];
  const logId = logIdOf(deps.v3);
  if (logId !== undefined) headers.push([SERVE_DATASTORE_LOG_HEADER, logId]);
  for (
    const header of callerReplyHeaders(
      deps.ctx.authConfig.mode,
      authenticated.principal,
    )
  ) {
    headers.push(header);
  }
  return withHeaders(response, headers);
}

/**
 * the principal is the one serve stamps on the caller's commits, which a new
 * run record must name; encoded, as a principal id may hold any character
 */
export function callerReplyHeaders(
  authMode: string,
  principal: string,
): [string, string][] {
  if (authMode === "none") {
    return [[
      SERVE_DATASTORE_FEATURES_HEADER,
      [
        STEP_STARTS_FEATURE,
        LEASE_HOLDER_FEATURE,
        AUTHORIZE_ONLY_FEATURE,
        COMMIT_BATCH_FEATURE,
      ].join(","),
    ]];
  }
  return [
    [
      SERVE_DATASTORE_FEATURES_HEADER,
      [
        STEP_STARTS_FEATURE,
        RUN_INITIATOR_FEATURE,
        LEASE_HOLDER_FEATURE,
        AUTHORIZE_ONLY_FEATURE,
        COMMIT_BATCH_FEATURE,
      ].join(","),
    ],
    [SERVE_DATASTORE_PRINCIPAL_HEADER, encodeURIComponent(principal)],
  ];
}

const MAX_AUTHORIZE_BODY_BYTES = 256 * 1024;
const MAX_AUTHORIZED_COMMITS = 16;
const MAX_AUTHORIZED_OPS = 64;

function heldMessage(
  lockKey: string,
  outcome: { readonly heldBy: LockHolder; readonly holder?: LeaseHolder },
): string {
  const { holder } = outcome;
  if (holder === undefined) return `${lockKey} is held by serve's own work`;
  const who = outcome.heldBy === "caller"
    ? `another command of ${holder.principal}`
    : holder.principal;
  return holder.explicit
    ? `${lockKey} is held by ${who} under an explicit lease until ${holder.expiresAt}`
    : `${lockKey} is held by ${who}`;
}

/**
 * The reply to a write that must wait for a new leader to adopt the kept
 * lease on its key (swamp-club#4195, swamp-club#4258): the retryable
 * serve_not_leader, naming no leader and no lease.
 */
function adoptionPendingResponse(): Response {
  return notLeaderResponse(new ServeNotLeaderError(undefined), false);
}

/**
 * Whether the client's copy understands lease ops (swamp-club#4121): it
 * names {@link LEASE_OPS_FEATURE} in {@link SERVE_DATASTORE_FEATURES_HEADER}.
 */
function readerFeatures(req: Request): ReaderFeatures {
  const named = (req.headers.get(SERVE_DATASTORE_FEATURES_HEADER) ?? "")
    .split(",")
    .map((feature) => feature.trim());
  return {
    leaseOps: named.includes(LEASE_OPS_FEATURE),
    stepStarts: named.includes(STEP_STARTS_FEATURE),
  };
}

/**
 * The reply a serve follower gives a datastore API request it does not
 * answer itself: a write is the leader's reply to it, forwarded with the
 * caller's own credentials (swamp-club#4120); so is a lease listing, since
 * leases live on the leader (swamp-club#4121). A read once its copy is
 * stale, or a write when no leader can be reached, is a retryable 503 that
 * names the leader (swamp-club#4096). A chunk check (`has`) is a read.
 */
function followerDatastoreRefusal(
  req: Request,
  route: DatastoreRoute,
  sourceIp: string,
  ctx: ConnectionContext,
): Promise<Response> | undefined {
  const gate = ctx.followerGate;
  if (gate === undefined || gate.role === "leader") return undefined;
  // Leases live on the leader, so listing them is the leader's to answer
  // (swamp-club#4121).
  const reads = (req.method === "GET" && route.kind !== "locks") ||
    route.kind === "has";
  if (reads && !gate.isStale()) return undefined;
  if (!reads && ctx.leaderLink !== undefined) {
    return ctx.leaderLink.forward(req, { clientIp: sourceIp });
  }
  return Promise.resolve(
    notLeaderResponse(new ServeNotLeaderError(gate.leader(), reads)),
  );
}

/** The read-access fingerprint of a caller with no authorization to apply. */
export const UNRESTRICTED_READ_ACCESS = "unrestricted";

/** The read-access fingerprint of a caller that may read nothing. */
export const NO_READ_ACCESS = "none";

/**
 * The fingerprint of what `caller` may read, as the read filter decides it
 * (`callerResourceDecider`): everything when authorization is off, nothing
 * without a principal or a policy, else the decision service's
 * fingerprint of the caller's grants and serve's restricted behavior types,
 * which only an admin may read. Undefined, so the reply names none,
 * when it cannot be taken: it is freshness, never a reason to fail a reply.
 */
function callerReadAccess(
  caller: ApiCaller,
  ctx: Pick<ConnectionContext, "authConfig" | "policySnapshotLoader">,
): string | undefined {
  if (ctx.authConfig.mode === "none") return UNRESTRICTED_READ_ACCESS;
  const loader = ctx.policySnapshotLoader;
  const { principal, collectives, groups, client, delegation } = caller.access;
  if (!loader || !principal) return NO_READ_ACCESS;
  try {
    return loader.decisionService.readAccessFingerprint(
      { principal, collectives, groups, client, delegation },
      ctx.authConfig.restrictedModelTypes,
    );
  } catch (error) {
    logger
      .warn`Could not fingerprint a datastore caller's read access: ${error}`;
    return undefined;
  }
}

/** The log's id; undefined when there is no v3 log, or it is closing. */
function logIdOf(v3: V3Datastore | undefined): string | undefined {
  try {
    return v3?.commitStore.logId();
  } catch {
    return undefined;
  }
}

/** `response` with `headers` set; a copy when its headers are fixed. */
function withHeaders(
  response: Response,
  headers: readonly [string, string][],
): Response {
  try {
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  } catch {
    const copied = new Headers(response.headers);
    for (const [name, value] of headers) copied.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: copied,
    });
  }
}

async function answerDatastoreRequest(
  req: Request,
  route: DatastoreRoute,
  caller: ApiCaller,
  deps: DatastoreApiDeps,
): Promise<Response> {
  const { ctx, v3 } = deps;
  if (
    ctx.auditEmitter && ctx.auditFailOpen === false &&
    (ctx.auditWal?.isFull === true ||
      ctx.auditWal?.hasDroppedEvents === true ||
      ctx.auditEmitter.durableStalled)
  ) {
    return failure(
      503,
      "audit_unavailable",
      "Request rejected: audit subsystem cannot durably record events (fail-secure mode)",
    );
  }
  if (v3 === undefined) {
    return failure(
      409,
      "datastore_not_v3",
      "This server's datastore is not a v3 datastore",
    );
  }
  if (route.namespace !== storageNamespaceOf(namespaceOf(v3))) {
    return failure(404, "not_found", "No such datastore namespace");
  }
  const api = new DatastoreApi(v3, caller, deps);
  try {
    switch (route.kind) {
      case "has":
        return req.method === "POST"
          ? await api.has(req)
          : methodNotAllowed("POST");
      case "chunk":
        if (req.method === "PUT") return await api.putChunk(req, route.sha256);
        if (req.method === "GET") return await api.getChunk(req, route.sha256);
        return methodNotAllowed("GET, PUT");
      case "batch":
        return req.method === "POST"
          ? await api.commitBatch(req)
          : methodNotAllowed("POST");
      case "commits":
        if (req.method === "POST") {
          return await api.commit(req, route.partition);
        }
        if (req.method === "GET") {
          return await api.partitionCommits(req, route.partition);
        }
        return methodNotAllowed("GET, POST");
      case "changes":
        return req.method === "GET"
          ? await api.changes(req)
          : methodNotAllowed("GET");
      case "authorize":
        return req.method === "POST"
          ? await api.authorize(req)
          : methodNotAllowed("POST");
      case "base":
        return req.method === "GET"
          ? await api.compactedBase(req)
          : methodNotAllowed("GET");
      case "locks":
        return req.method === "POST"
          ? await api.acquireLock(req)
          : req.method === "GET"
          ? await api.listLocks(req)
          : req.method === "DELETE"
          ? await api.forceReleaseLock(req)
          : methodNotAllowed("DELETE, GET, POST");
      case "lease":
        if (req.method === "PUT") {
          return await api.renewLock(req, route.leaseId);
        }
        if (req.method === "DELETE") {
          return await api.releaseLock(route.leaseId);
        }
        return methodNotAllowed("DELETE, PUT");
      case "quarantine":
        return req.method === "POST"
          ? await api.depositQuarantine(req)
          : methodNotAllowed("POST");
      case "quarantine-accept":
        return req.method === "POST"
          ? await api.acceptQuarantine(req, route.txnId)
          : methodNotAllowed("POST");
      case "quarantine-discard":
        return req.method === "POST"
          ? await api.discardQuarantine(route.txnId)
          : methodNotAllowed("POST");
      case "quarantine-change":
        return req.method === "GET"
          ? await api.quarantineState(route.txnId)
          : methodNotAllowed("GET");
    }
  } catch (error) {
    return datastoreErrorResponse(error);
  }
}

/** One request's view of the datastore, as one caller. */
class DatastoreApi {
  readonly #v3: V3Datastore;
  readonly #caller: ApiCaller;
  readonly #deps: DatastoreApiDeps;
  readonly #resolver: AggregateResourceResolver;
  readonly #namespace: string;
  readonly #storageNamespace: string;
  readonly #requestId = crypto.randomUUID();
  readonly #readers = new Map<Action, (resource: AccessResource) => boolean>();

  constructor(v3: V3Datastore, caller: ApiCaller, deps: DatastoreApiDeps) {
    this.#v3 = v3;
    this.#caller = caller;
    this.#deps = deps;
    this.#namespace = v3.namespace;
    this.#storageNamespace = storageNamespaceOf(namespaceOf(v3));
    this.#resolver = memoized(serveResolver(deps.ctx, v3));
  }

  /** `POST chunks/has`. */
  async has(req: Request): Promise<Response> {
    const body = await readJson(req, 256 * 1024);
    const hashes = (body as { hashes?: unknown })?.hashes;
    if (
      !Array.isArray(hashes) || hashes.length > MAX_HAS_HASHES ||
      !hashes.every((hash) => typeof hash === "string" && isSha256Hex(hash))
    ) {
      return failure(
        400,
        "invalid_request",
        `Body must be {"hashes": [...]} with at most ${MAX_HAS_HASHES} SHA-256 hex digests`,
      );
    }
    // Only chunks the caller could reference are answered for: anything
    // else reads as missing, so the answer reveals no other content. One
    // budget covers every hash (swamp-club#4260). A hash it cannot decide
    // is left out too: only writers ask, before they upload, so absent
    // makes them send the bytes, which the upload ledger then vouches for.
    // A reader asks GET chunks, which says undecided rather than missing.
    const budget = this.#vouchBudget();
    const referable: string[] = [];
    for (const hash of new Set(hashes as string[])) {
      if (await this.#mayReference(hash, budget) === "vouched") {
        referable.push(hash);
      }
    }
    const signal = req.signal;
    const storage = this.#v3.storage;
    let held: Set<string>;
    if (storage.touch !== undefined) {
      const missing = await storage.touch(
        this.#storageNamespace,
        referable,
        signal,
      );
      held = new Set(referable.filter((hash) => !missing.has(hash)));
    } else {
      held = await storage.has(this.#storageNamespace, referable, signal);
    }
    return Response.json({ held: [...held] });
  }

  /** `PUT chunks/{sha256}`: one chunk, recorded in the upload ledger. */
  async putChunk(req: Request, sha256: string): Promise<Response> {
    if (!isSha256Hex(sha256)) {
      return failure(400, "invalid_request", "Not a SHA-256 hex digest");
    }
    const length = req.headers.get("content-length");
    const size = length === null || length.trim() === "" ? NaN : Number(length);
    if (!Number.isSafeInteger(size) || size < 0) {
      return failure(411, "length_required", "Content-Length is required");
    }
    // An upload spends serve's storage and the caller's quota, so it needs
    // the least access a write to the partition it is for needs
    // (swamp-club#3922), decided before anything is reserved or read. With
    // no partition named it needs admin. What a commit may name it for is
    // still decided on the commit.
    const named = new URL(req.url).searchParams.get("partition");
    let required: RequiredAccess = {
      action: "admin",
      resource: ADMIN_RESOURCE,
    };
    if (named !== null) {
      const partition = parsePartition(named);
      if (partition === undefined) {
        return failure(400, "invalid_request", "Not a partition key");
      }
      await this.#catchUp();
      required = await partitionWriteAccessOf(partition, this.#resolver);
    }
    if (!this.#writeAuthority().allows(required.action, required.resource)) {
      return failure(
        403,
        "forbidden",
        named === null
          ? "Uploading a chunk for no partition needs admin"
          : `Uploading a chunk for ${named} needs ${required.action} on ${required.resource.kind}:${required.resource.name}`,
      );
    }
    const now = this.#now();
    const admission = this.#deps.ledger.reserve(
      this.#caller.principal,
      size,
      now,
    );
    if (!admission.allowed) return uploadQuotaExceeded();
    const { reservation } = admission;
    try {
      return await this.#withChunkSlot(async () => {
        const reader = new FramedReader(req.body ?? ReadableStream.from([]), {
          maxBytes: size,
        });
        const chunk = await ingestChunk(
          reader,
          { sha256, size },
          { maxChunkBytes: this.#maxChunkBytes() },
          req.signal,
        );
        await reader.assertEnd(req.signal);
        await this.#store([chunk], req.signal);
        this.#deps.ledger.record(
          reservation,
          this.#storageNamespace,
          sha256,
          now,
        );
        return Response.json({ sha256, size }, { status: 201 });
      });
    } finally {
      reservation.cancel();
    }
  }

  /** `GET chunks/{sha256}`. */
  async getChunk(req: Request, sha256: string): Promise<Response> {
    if (!isSha256Hex(sha256)) {
      return failure(400, "invalid_request", "Not a SHA-256 hex digest");
    }
    // A chunk the caller may not read is answered as one that does not
    // exist, so the reply is no oracle for others' content. One the budget
    // could not decide is not answered as missing (swamp-club#4260): the
    // reply names no partition, only that the read was not decided. The
    // decision runs inside the chunk slot, so a principal's concurrent
    // reads bound the work it can start.
    return await this.#withChunkSlot(async () => {
      const vouch = await this.#mayReference(sha256, this.#vouchBudget());
      if (vouch === "undecided") {
        return failure(
          503,
          CHUNK_ACCESS_UNDECIDED_CODE,
          "Whether this chunk may be read could not be decided within this request's limits",
        );
      }
      if (vouch === "refused") {
        return failure(404, "not_found", "No such chunk");
      }
      const bytes = await this.#v3.storage.get(
        this.#storageNamespace,
        sha256,
        req.signal,
      );
      if (bytes === null) return failure(404, "not_found", "No such chunk");
      if (await sha256Hex(bytes) !== sha256) {
        logger.error`Stored chunk ${sha256} does not hold its own bytes`;
        return failure(500, "chunk_corrupt", "The stored chunk is damaged");
      }
      return chunkReadResponse(
        bytes,
        parseRange(req.headers.get("range"), bytes.length),
        sha256,
      );
    });
  }

  /**
   * checks tombstones without appending, so a multi-partition delete learns of
   * a refusal before its first commit; refusals are audited as commits' are
   */
  async authorize(req: Request): Promise<Response> {
    const body = await readJson(req, MAX_AUTHORIZE_BODY_BYTES);
    const commits = typeof body === "object" && body !== null &&
        Array.isArray((body as { commits?: unknown }).commits)
      ? (body as { commits: unknown[] }).commits
      : undefined;
    if (commits === undefined || commits.length > MAX_AUTHORIZED_COMMITS) {
      return failure(
        400,
        "invalid_request",
        `Body must be {"commits": [{"partition", "ops"}]}, at most ${MAX_AUTHORIZED_COMMITS} commits`,
      );
    }
    const parsed: { partition: PartitionKey; ops: Op[] }[] = [];
    try {
      for (const raw of commits) {
        const fields = raw as { partition?: unknown; ops?: unknown };
        const partition = typeof fields.partition === "string"
          ? parsePartition(fields.partition)
          : undefined;
        if (
          partition === undefined || !Array.isArray(fields.ops) ||
          fields.ops.length === 0 || fields.ops.length > MAX_AUTHORIZED_OPS
        ) {
          throw new Error("each commit names a partition and its ops");
        }
        const ops = await Promise.all(fields.ops.map((op) => opFromJSON(op)));
        if (ops.some((op) => op.kind !== "tombstone")) {
          throw new Error("only removals are authorized ahead");
        }
        parsed.push({ partition, ops });
      }
    } catch (error) {
      return failure(
        400,
        "invalid_request",
        `Malformed authorize request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.#catchUp();
    const verdicts = [];
    for (const { partition, ops } of parsed) {
      const checked = await authorizeCommit(
        partition,
        ops,
        this.#resolver,
        this.#writeAuthority(),
        "deferred",
      );
      verdicts.push(
        checked.ok ? { ok: true } : {
          ok: false,
          reason: checked.reason,
          opIndex: checked.opIndex,
          message: checked.message,
        },
      );
    }
    return Response.json({ verdicts });
  }

  /** `POST partitions/{p}/commits`. */
  async commit(req: Request, partitionSegment: string): Promise<Response> {
    const partition = parsePartition(partitionSegment);
    if (partition === undefined) {
      return failure(400, "invalid_request", "Not a partition key");
    }
    const reader = new FramedReader(req.body ?? ReadableStream.from([]), {
      maxBytes: MAX_COMMIT_BODY_BYTES,
    });
    const landed = await this.#commitOne(reader, partition, req.signal, true);
    if (landed instanceof Response) return landed;
    const unconfirmed = await this.#confirmLanded([landed]);
    if (unconfirmed !== undefined) {
      return Response.json({ ...unconfirmed, seq: landed.result.seq }, {
        status: 503,
      });
    }
    return Response.json(await this.#landedReply(req, landed));
  }

  /**
   * `POST commits`: commits to several partitions in one request, applied in
   * order through the single route's own checks, stopping at the first that
   * does not land, and confirmed as replicated once for all of them
   */
  async commitBatch(req: Request): Promise<Response> {
    const reader = new FramedReader(req.body ?? ReadableStream.from([]), {
      maxBytes: MAX_COMMIT_BODY_BYTES,
    });
    let header: BatchHeader;
    try {
      const headerLength = await reader.readUint32BE(req.signal);
      if (headerLength > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        return failure(
          413,
          "envelope_too_large",
          `The batch header exceeds ${MAX_ENVELOPE_BYTES} bytes`,
        );
      }
      header = parseBatchHeader(
        JSON.parse(
          new TextDecoder().decode(
            await reader.readExactly(headerLength, req.signal),
          ),
        ),
      );
    } catch (error) {
      await reader.cancel();
      if (error instanceof ChunkIngestError) throw error;
      return failure(
        400,
        "invalid_request",
        `Malformed batch: ${error instanceof Error ? error.message : error}`,
      );
    }
    const landed: LandedCommit[] = [];
    let refused: BatchItemReply | undefined;
    for (const [index, item] of header.items.entries()) {
      const partition = parsePartition(item.partition);
      let outcome: Response | LandedCommit;
      try {
        outcome = partition === undefined
          ? failure(400, "invalid_request", "Not a partition key")
          : await this.#commitOne(
            reader,
            partition,
            req.signal,
            index === header.items.length - 1,
          );
      } catch (error) {
        outcome = datastoreErrorResponse(error);
      }
      if (outcome instanceof Response) {
        await reader.cancel();
        refused = await batchItemReplyOf(outcome);
        break;
      }
      landed.push(outcome);
    }
    const unconfirmed = landed.length === 0
      ? undefined
      : await this.#confirmLanded(landed);
    const results: BatchItemReply[] = [];
    for (const commit of landed) {
      results.push(
        unconfirmed === undefined
          ? { status: 200, body: await this.#landedReply(req, commit) }
          : {
            status: 503,
            body: { ...unconfirmed, seq: commit.result.seq },
          },
      );
    }
    if (refused !== undefined) results.push(refused);
    // A command's own lease ends with the commits it guarded, once all of them
    // are confirmed; an explicit lease outlives the command and is never ended
    // here.
    let released = false;
    if (
      header.release !== undefined && unconfirmed === undefined &&
      landed.length === header.items.length
    ) {
      const held = this.#deps.locks.lease(
        this.#caller.principal,
        header.release,
      );
      if (held !== undefined && held.view.holdMs === undefined) {
        released = await this.#deps.locks.release(
          this.#caller.principal,
          header.release,
        );
      }
    }
    return Response.json({
      results,
      ...(released ? { released: true } : {}),
    });
  }

  /** what the reply to a landed commit says, the commit included if readable */
  async #landedReply(
    req: Request,
    landed: LandedCommit,
  ): Promise<Record<string, unknown>> {
    const { result, warning, partition } = landed;
    // Checked as a read of the partition is, so a reply never shows a commit
    // the caller could not read back.
    const readable = await this.#mayRead(
      await partitionReadAccessOf(partition, this.#resolver),
    ) && await this.#mayReadCommit(result.commit.partition, result.commit.ops);
    const commit = readable
      ? commitJSONFor(result.commit, readerFeatures(req))
      : undefined;
    const parentTxnId = commit === undefined
      ? undefined
      : await this.#readableParentTxnId(result.commit);
    return {
      seq: result.seq,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(warning === undefined ? {} : { warning }),
      ...(commit === undefined ? {} : { commit }),
      ...(parentTxnId === undefined ? {} : { parentTxnId }),
    };
  }

  /**
   * the txnId at the seq before `commit`, which a copy checks its own head
   * against before taking the commit; undefined when compacted or unreadable
   */
  async #readableParentTxnId(commit: Commit): Promise<string | undefined> {
    if (commit.seq <= 1) return undefined;
    let parent: Commit | undefined;
    try {
      [parent] = (await this.#v3.commitStore.readPartition(
        this.#namespace,
        commit.partition,
        commit.seq - 1,
        1,
      )).map((change) => change.commit);
    } catch (error) {
      if (error instanceof CommitsCompactedError) return undefined;
      throw error;
    }
    if (
      parent === undefined || parent.seq !== commit.seq - 1 ||
      !(await this.#mayReadCommit(parent.partition, parent.ops))
    ) {
      return undefined;
    }
    return parent.txnId;
  }

  /** undefined once every commit is replicated; the client's error otherwise */
  async #confirmLanded(
    landed: readonly LandedCommit[],
  ): Promise<{ code: string; message: string } | undefined> {
    const ctx = this.#deps.ctx;
    const confirmReplicated = ctx.confirmReplicated?.bind(ctx);
    if (confirmReplicated === undefined) return undefined;
    try {
      await withSpan(
        "swamp.serve.datastore.confirm_replicated",
        {},
        () => confirmReplicated(),
      );
      return undefined;
    } catch (error) {
      // Landed, and not yet replicated: a retry under the same txnId finds it.
      const { code, message } = replicationErrorForClient(
        error,
        "internal_error",
      );
      for (const { result, partition } of landed) {
        logger
          .warn`Commit ${result.seq} to partition ${partition} landed but could not be confirmed as replicated (${code}): ${error}`;
      }
      return { code, message };
    }
  }

  /**
   * one commit read from `reader`: refused as a Response, or landed and caught
   * up after, not yet confirmed as replicated
   */
  async #commitOne(
    reader: FramedReader,
    partition: PartitionKey,
    signal: AbortSignal,
    last: boolean,
  ): Promise<Response | LandedCommit> {
    const envelopeLength = await reader.readUint32BE(signal);
    if (envelopeLength > MAX_ENVELOPE_BYTES) {
      await reader.cancel();
      return failure(
        413,
        "envelope_too_large",
        `The commit envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      );
    }
    let envelope: CommitEnvelope;
    let ops: Op[];
    try {
      envelope = parseEnvelope(
        JSON.parse(
          new TextDecoder().decode(
            await reader.readExactly(envelopeLength, signal),
          ),
        ),
      );
      ops = await Promise.all(envelope.ops.map((op) => opFromJSON(op)));
    } catch (error) {
      await reader.cancel();
      if (error instanceof ChunkIngestError) throw error;
      return failure(
        400,
        "invalid_request",
        `Malformed commit: ${error instanceof Error ? error.message : error}`,
      );
    }
    // Key ownership is read from serve's read model: catch it up first, so
    // it includes everything serve itself committed. Content is checked
    // once it has arrived, below; this pass refuses early on access alone.
    let authorization;
    try {
      await this.#catchUp();
      authorization = await authorizeCommit(
        partition,
        ops,
        this.#resolver,
        this.#writeAuthority(),
        "deferred",
      );
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    if (!authorization.ok) {
      await reader.cancel();
      return refusalResponse(authorization);
    }
    // A kept lease on this partition not adopted yet would let the commit
    // land past its holder (swamp-club#4258): refused before the upload,
    // and judged again under the lock below. Checked once the caller may
    // write here, so it never says to anyone else whether a lease does.
    if (this.#adoptionPendingOn(partition)) {
      await reader.cancel();
      return adoptionPendingResponse();
    }
    const referenced = referencedChunks(ops);
    // Every chunk named and not carried is checked under the forwarded
    // lock, which every caller's commits share: bound that work, before
    // any carried chunk is read. The envelope lists what the body carries.
    const declared = new Set(envelope.chunks.map((chunk) => chunk.sha256));
    if (
      referenced.filter((hash) => !declared.has(hash)).length >
        MAX_CHUNKS_PER_COMMIT
    ) {
      await reader.cancel();
      return failure(
        413,
        "too_many_chunks",
        `A commit may name at most ${MAX_CHUNKS_PER_COMMIT} chunks it does not carry`,
      );
    }
    // The content arrives after the envelope. Room for each chunk is
    // reserved in the upload ledger before it is read, so the quota counts
    // what it has sent so far. A mismatch fails the request before anything
    // is committed.
    let provided: Set<string> | Response;
    try {
      provided = await this.#withChunkSlot(() =>
        this.#ingestCarried(reader, envelope.chunks, signal, last)
      );
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    if (provided instanceof Response) {
      await reader.cancel();
      return provided;
    }
    const carried = provided;
    const request = {
      partition,
      txnId: envelope.txnId,
      expectedSeq: envelope.expectedSeq,
      ...(envelope.fence === undefined ? {} : { fence: envelope.fence }),
      principal: this.#caller.principal,
      ops,
    };
    // Content is checked outside the forwarded lock, which every caller's
    // commits share: the checks read definitions and the catalog. Every
    // record they read is guarded below. A retry of a commit that already
    // landed is answered as it, without judging its content again.
    let content: ForwardedContentAuthority | undefined;
    if (await landedForwardedCommit(this.#v3, request) === undefined) {
      await this.#catchUp();
      const resolver = memoized(serveResolver(this.#deps.ctx, this.#v3));
      // Possession is decided once, before the content check reads any of
      // it, so a chunk the budget cannot decide is answered as not
      // provided (the client sends its bytes) rather than refused as
      // content (swamp-club#4260).
      const uncarried = referenced.filter((hash) => !carried.has(hash)).length;
      const possession = this.#commitVouchBudget(uncarried);
      const vouched = new Set<string>();
      const refused = new Set<string>();
      for (const hash of referenced) {
        if (carried.has(hash)) continue;
        const vouch = await this.#mayReference(hash, possession, resolver);
        if (vouch === "vouched") vouched.add(hash);
        else if (vouch === "refused") refused.add(hash);
        else return chunkNotProvided(hash);
      }
      content = new ForwardedContentAuthority({
        ctx: this.#deps.ctx,
        v3: this.#v3,
        partition,
        caller: this.#caller.access,
        requestId: this.#requestId,
        resolver,
        possesses: async (hash) =>
          carried.has(hash) || vouched.has(hash) ||
          (!refused.has(hash) &&
            await this.#mayReference(hash, possession, resolver) ===
              "vouched"),
        signal: signal,
      });
      const checked = await authorizeCommit(
        partition,
        ops,
        resolver,
        this.#writeAuthority(),
        content,
      );
      if (!checked.ok) return refusalResponse(checked);
    }
    // Authorised again under the datastore's forwarded-commit lock, once the
    // content is in: key ownership cannot change between the check and the
    // append, and a grant revoked during the upload applies.
    const lockWaitFrom = performance.now();
    const landed = await withForwardedLock(this.#v3, async () => {
      setActiveSpanAttributes({
        "swamp.serve.datastore.lock_wait_ms": Math.round(
          performance.now() - lockWaitFrom,
        ),
      });
      await this.#catchUp();
      // A retry of a commit that landed is answered before proof of
      // possession: its chunks may since have left the upload ledger.
      const duplicate = await landedForwardedCommit(this.#v3, request);
      if (duplicate !== undefined) return { result: duplicate };
      if (content === undefined) return { contentChanged: true as const };
      // Looked up afresh: a definition retagged during the upload is judged
      // as it is now.
      const resolver = memoized(serveResolver(this.#deps.ctx, this.#v3));
      const recheck = await authorizeCommit(
        partition,
        ops,
        resolver,
        this.#writeAuthority(),
        "deferred",
      );
      if (!recheck.ok) return recheck;
      // The records the content was judged against must not have moved.
      if (!(await content.unchanged())) {
        return { contentChanged: true as const };
      }
      // Proof of possession under the lock too, so a read grant revoked
      // during the upload no longer vouches for a chunk. Its own budget
      // bounds the work done under the lock (swamp-club#4260); a chunk it
      // cannot decide is not provided, and the client sends its bytes.
      const underLock = this.#commitVouchBudget(
        referenced.filter((hash) => !carried.has(hash)).length,
      );
      for (const hash of referenced) {
        if (
          carried.has(hash) ||
          (await this.#mayReference(hash, underLock, resolver) === "vouched")
        ) {
          continue;
        }
        return { notProvided: hash };
      }
      // Judged under the forwarded lock, as leases change hands between
      // commits: the live fenced lease covering the partition decides, once
      // any kept lease on it is adopted.
      if (this.#adoptionPendingOn(partition)) {
        return { adoptionPending: true as const };
      }
      const lease = this.#leaseOpFor(partition, envelope.lease);
      if (lease === "lost") return { leaseLost: true as const };
      const result = await commitForwarded(
        this.#v3,
        {
          ...request,
          ...(lease === undefined ? {} : { lease }),
          stored: carried,
        },
        signal,
      );
      return { result };
    });
    if ("adoptionPending" in landed) return adoptionPendingResponse();
    if ("contentChanged" in landed) {
      return failure(
        409,
        "content_changed",
        "A record this commit was checked against changed: check the commit again and retry",
      );
    }
    if ("leaseLost" in landed) {
      // Never says whose lease holds the partition, or whether one does.
      return failure(
        409,
        "commit_lease-lost",
        "This commit's model lease is not held: take the lock again and retry",
      );
    }
    if ("notProvided" in landed) return chunkNotProvided(landed.notProvided);
    if ("ok" in landed) return refusalResponse(landed);
    const { result } = landed;
    this.#deps.ledger.release(this.#storageNamespace, referenced);
    // Outside the lock: the next forwarded commit catches up before it
    // authorises anyway, so holding the lock for this one gains nothing.
    const warning = await withSpan(
      "swamp.serve.datastore.after_commit",
      {},
      () => this.#afterCommit(partition),
    );
    return { partition, result, ...(warning === undefined ? {} : { warning }) };
  }

  /** `GET partitions/{p}/commits?after={seq}&limit=`. */
  async partitionCommits(
    req: Request,
    partitionSegment: string,
  ): Promise<Response> {
    const partition = parsePartition(partitionSegment);
    if (partition === undefined) {
      return failure(400, "invalid_request", "Not a partition key");
    }
    const params = new URL(req.url).searchParams;
    const after = nonNegative(params.get("after") ?? "0");
    const limit = pageLimit(params.get("limit"));
    if (after === undefined || limit === undefined) {
      return failure(
        400,
        "invalid_request",
        "after and limit must be integers",
      );
    }
    // The seq the caller's copy holds in the partition (swamp-club#4254).
    const heldParam = params.get("held");
    const held = heldParam === null ? undefined : nonNegative(heldParam);
    if (heldParam !== null && held === undefined) {
      return failure(400, "invalid_request", "held must be an integer");
    }
    if (
      !(await this.#mayRead(
        await partitionReadAccessOf(partition, this.#resolver),
      ))
    ) {
      return failure(404, "not_found", "No such partition");
    }
    // Only once the caller may read the partition, so the refusal tells
    // nothing of one it may not.
    if (held !== undefined && await this.#behindCaller(partition, held)) {
      return followerBehindResponse();
    }
    const page = await this.#v3.commitStore.readPartition(
      this.#namespace,
      partition,
      after + 1,
      limit,
    );
    const head = await this.#v3.commitStore.head(this.#namespace, partition);
    // Each commit is filtered as the changes feed filters it: a partition
    // can hold commits its identity alone cannot tell apart, such as a
    // control-plane definition sharing a name with an ordinary one
    // (swamp-club#3938).
    const commits: unknown[] = [];
    for (const change of page) {
      if (
        await this.#mayReadCommit(change.commit.partition, change.commit.ops)
      ) {
        const json = commitJSONFor(change.commit, readerFeatures(req));
        if (json !== undefined) commits.push(json);
      }
    }
    return Response.json({ head: head.seq, commits });
  }

  /**
   * Whether this node is a follower whose copy holds less of `partition`
   * than the caller's, which holds seq `held` (swamp-club#4254), as a node
   * restarted after a takeover is until its leader feed catches it up. Its
   * head would read to the caller as a rewind, so it waits for its feed
   * first. A follower that then holds a head its leader named after the
   * caller asked answers as the leader would, so a log genuinely behind the
   * caller is still refused by the caller as diverged. A leader always
   * answers, and so does a follower with no leader feed or one stuck for
   * long: it cannot tell catching up from a log behind the caller, and a
   * refusal it could never lift would hide a real rewind for good.
   */
  async #behindCaller(
    partition: PartitionKey,
    held: number,
  ): Promise<boolean> {
    if (this.#deps.ctx.followerGate?.role !== "follower") return false;
    const catchUp = this.#deps.ctx.followerCatchUp;
    if (catchUp === undefined) return false;
    const head = async () =>
      (await this.#v3.commitStore.head(this.#namespace, partition)).seq;
    if (held <= await head()) return false;
    const standing = await catchUp();
    if (held <= await head()) return false;
    return standing === "catching-up";
  }

  /** `GET changes?cursor={c}&limit=`. */
  async changes(req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const cursor = nonNegative(params.get("cursor") ?? "0");
    const limit = pageLimit(params.get("limit"));
    if (cursor === undefined || limit === undefined) {
      return failure(
        400,
        "invalid_request",
        "cursor and limit must be integers",
      );
    }
    const anchor = parseAnchorParams(params);
    if (anchor === "invalid") {
      return failure(
        400,
        "invalid_request",
        "anchorNamespace, anchorPartition, anchorSeq and anchorTxnId go together",
      );
    }
    // checked before the page is read, as the caller checks it before applying
    // any of it
    const verdict = anchor === undefined
      ? undefined
      : await this.#anchorVerdict(anchor);
    if (verdict instanceof Response) return verdict;
    const page = await this.#changesPage(req, cursor, limit);
    return Response.json({
      ...page,
      ...(verdict === undefined ? {} : { anchor: verdict }),
    });
  }

  /**
   * the changes feed after `cursor`, as the caller may read it; `maxBytes`
   * ends a page early, with more to read
   */
  async #changesPage(
    req: Request,
    cursor: number,
    limit: number,
    maxBytes?: number,
  ): Promise<{ changes: ChangeEntryJson[]; cursor: number; more: boolean }> {
    // A follower pages only to the last commit whose effects it applied:
    // a commit past it would be filtered under a policy older than it, and
    // the cursor would move past it for good (swamp-club#4207).
    const bound = this.#deps.ctx.followerGate?.role === "follower"
      ? this.#deps.ctx.commitFeed?.bound()
      : undefined;
    const kept: ChangeEntryJson[] = [];
    let next = cursor;
    let scanned = 0;
    let bytes = 0;
    let more = true;
    scan: while (kept.length < limit && scanned < MAX_CHANGES_SCAN) {
      const page = await this.#v3.commitStore.changesSince(
        next,
        Math.min(MAX_PAGE, MAX_CHANGES_SCAN - scanned),
      );
      if (page.length === 0) {
        more = false;
        break;
      }
      for (const change of page) {
        if (bound !== undefined && change.cursor > bound) {
          more = false;
          break scan;
        }
        if (
          change.commit.namespace === this.#namespace &&
          (await this.#mayReadCommit(
            change.commit.partition,
            change.commit.ops,
          ))
        ) {
          const commit = commitJSONFor(change.commit, readerFeatures(req));
          if (commit !== undefined) {
            if (maxBytes !== undefined) {
              const size =
                new TextEncoder().encode(JSON.stringify(commit)).byteLength;
              // the cursor stays before this commit, which the next read
              // brings
              if (kept.length > 0 && bytes + size > maxBytes) break scan;
              bytes += size;
            }
            scanned++;
            next = change.cursor;
            kept.push({ cursor: change.cursor, commit });
            if (kept.length >= limit) break;
            continue;
          }
        }
        scanned++;
        next = change.cursor;
      }
    }
    // The next cursor moves past filtered rows too, so a caller who may
    // read nothing still makes progress.
    return { changes: kept, cursor: next, more };
  }

  /**
   * whether serve still holds the commit the caller's feed cursor follows, as
   * the caller would read it from the anchor's partition
   */
  async #anchorVerdict(
    anchor: FeedAnchorJson,
  ): Promise<AnchorVerdict | Response> {
    const partition = parsePartition(anchor.partition);
    if (partition === undefined) return { verdict: "unchecked" };
    if (
      !(await this.#mayRead(
        await partitionReadAccessOf(partition, this.#resolver),
      ))
    ) {
      return { verdict: "unchecked" };
    }
    if (await this.#behindCaller(partition, anchor.seq)) {
      return followerBehindResponse();
    }
    let page;
    try {
      page = await this.#v3.commitStore.readPartition(
        this.#namespace,
        partition,
        anchor.seq,
        1,
      );
    } catch (error) {
      if (error instanceof CommitsCompactedError) {
        return { verdict: "unchecked" };
      }
      throw error;
    }
    const head = await this.#v3.commitStore.head(this.#namespace, partition);
    if (head.seq < anchor.seq) {
      return { verdict: "behind", serveHead: head.seq };
    }
    const [change] = page;
    if (
      change === undefined || change.commit.seq !== anchor.seq ||
      !(await this.#mayReadCommit(change.commit.partition, change.commit.ops))
    ) {
      return { verdict: "unchecked" };
    }
    if (
      change.commit.txnId !== anchor.txnId ||
      change.commit.namespace !== anchor.namespace
    ) {
      return { verdict: "other-commit", serveTxnId: change.commit.txnId };
    }
    return { verdict: "held" };
  }

  /**
   * what the caller's copy lacks, answered with the lock it is granted; never
   * fails the grant, which has already been made
   */
  async #lockCatchUp(
    req: Request,
    request: CatchUpRequestJson,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const verdict = request.anchor === undefined
        ? undefined
        : await this.#anchorVerdict(request.anchor);
      if (verdict instanceof Response) return undefined;
      const page = await this.#changesPage(
        req,
        request.cursor,
        MAX_PAGE,
        LOCK_CATCH_UP_BYTES,
      );
      return {
        requested: request,
        ...page,
        ...(verdict === undefined ? {} : { anchor: verdict }),
      };
    } catch (error) {
      if (error instanceof CommitsCompactedError) {
        return {
          requested: request,
          refused: await batchItemReplyOf(datastoreErrorResponse(error)),
        };
      }
      logger
        .debug`Answering a lock without its catch-up, which the caller reads itself: ${error}`;
      return undefined;
    }
  }

  /**
   * `GET base?after={token}&limit=` (swamp-club#4006): the compacted base of
   * this namespace, a page at a time, with only what the caller may read.
   * Each entry is decided by its partition and key, never more loosely than
   * the changes feed decides the op that wrote it. A partition the caller
   * may read as a whole is sent in its own section; one it may not (a
   * config partition same-named definitions share) is sent just before the
   * first entry of it the caller may read, so each entry arrives with its
   * partition's compacted seq. `next` moves past filtered entries, so a
   * caller who may read nothing still reaches the end. A page holds entries
   * of one compaction point: when the point moves mid-request, the page ends
   * there and the next one reports the new point.
   */
  async compactedBase(req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const after = params.get("after") ?? undefined;
    const limit = pageLimit(params.get("limit"));
    if (limit === undefined) {
      return failure(400, "invalid_request", "limit must be an integer");
    }
    const store = this.#v3.commitStore;
    const entries: Record<string, unknown>[] = [];
    const announced = new Set<string>();
    let next = after;
    let point: number | undefined;
    let scanned = 0;
    let kept = 0;
    while (kept < limit && scanned < MAX_BASE_SCAN) {
      let page;
      try {
        page = await store.readCompactedBase(
          next,
          Math.min(limit - kept, MAX_BASE_SCAN - scanned),
        );
      } catch (error) {
        if (!(error instanceof InvalidBasePageTokenError)) throw error;
        return failure(
          400,
          "invalid_request",
          "after must be the next token of a base page",
        );
      }
      if (point === undefined) point = page.point;
      else if (page.point !== point) break;
      for (const entry of page.entries) {
        scanned++;
        if (entry.namespace !== this.#namespace) continue;
        const readable = await this.#readableBaseEntry(entry, announced);
        if (readable === undefined) continue;
        for (const sent of readable) {
          entries.push(observedBaseEntryToJSON(sent));
        }
        kept++;
      }
      next = page.next;
      if (next === undefined) break;
    }
    return Response.json({
      point: point ?? 0,
      entries,
      ...(next === undefined ? {} : { next }),
    });
  }

  /**
   * The entries to send for `entry`: none when the caller may not read it,
   * else the entry, after its partition's when that was not sent yet.
   */
  async #readableBaseEntry(
    entry: CompactedBaseEntry,
    announced: Set<string>,
  ): Promise<ObservedBaseEntry[] | undefined> {
    if (entry.kind === "partition") {
      const partition = PartitionKey.parse(entry.partition);
      if (
        !this.#mayRead(await partitionReadAccessOf(partition, this.#resolver))
      ) {
        return undefined;
      }
      const marks = await this.#compactedPartition(partition);
      if (marks === undefined) return undefined;
      announced.add(entry.partition);
      return [marks];
    }
    const owner = entry.kind === "file"
      ? entry.ownership.owner
      : entry.partition;
    const partition = PartitionKey.parse(owner);
    const required = entry.kind === "record" || entry.kind === "file"
      ? await baseRecordReadAccessOf(
        partition,
        RecordKey.create(entry.key),
        this.#resolver,
      )
      : await baseDataReadAccessOf(partition, this.#resolver);
    if (!this.#mayRead(required)) return undefined;
    if (announced.has(owner)) return [entry];
    announced.add(owner);
    const marks = await this.#compactedPartition(partition);
    return marks === undefined ? [entry] : [marks, entry];
  }

  /**
   * A compacted partition's entry: its compacted seq, and its data names'
   * marks when the caller may read its data.
   */
  async #compactedPartition(
    partition: PartitionKey,
  ): Promise<ObservedBaseEntry | undefined> {
    const marks = await this.#v3.commitStore.compactedPartition(
      this.#namespace,
      partition,
    );
    if (marks === undefined) return undefined;
    const names = marks.names.length > 0 &&
        this.#mayRead(await baseDataReadAccessOf(partition, this.#resolver))
      ? marks.names
      : [];
    return {
      kind: "partition",
      namespace: this.#namespace,
      partition: partition.toString(),
      seq: marks.seq,
      names,
    };
  }

  /**
   * `POST locks`: `{lockKey, ttlMs?, waitMs?, fenced?}`. Takes serve's own
   * lock for a behavior (`data/{type}/{id}/.lock`) or a workflow run's
   * claim (`workflow-run-claims/{runId}/.lock`) for the caller, waiting up
   * to `waitMs` at serve while it is held. The key is parsed and made
   * canonical before it is authorised: `run` on the behavior or on the
   * run's workflow, as a write to its partition needs (swamp-club#3985).
   *
   * A `fenced` lease (swamp-club#4121) also returns its fence and, for a
   * behavior, its data-version floor: each data name's high-water mark and
   * removed versions, even to a caller that cannot read the data, since a
   * writer must know which versions are used. Names and numbers only.
   */
  async acquireLock(req: Request): Promise<Response> {
    const body = await readJson(req, 16 * 1024);
    const fields = typeof body === "object" && body !== null &&
        !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined;
    const target = parseLockKey(fields?.lockKey);
    if (fields === undefined || target === undefined) {
      return failure(
        400,
        "invalid_request",
        'Body must be {"lockKey": "data/{type}/{id}/.lock" or "workflow-run-claims/{runId}/.lock", "ttlMs"?, "waitMs"?, "fenced"?}',
      );
    }
    const fenced = fields.fenced ?? false;
    if (typeof fenced !== "boolean") {
      return failure(400, "invalid_request", "fenced must be a boolean");
    }
    // An explicit lease (swamp-club#4121) is held for its hold between
    // renewals, which may pass the TTL bounds up to its own.
    const holdMs = fields.holdMs;
    if (holdMs !== undefined) {
      const { min, max } = this.#deps.locks.holdBounds;
      if (
        typeof holdMs !== "number" || !Number.isSafeInteger(holdMs) ||
        holdMs < min || holdMs > max
      ) {
        return failure(
          400,
          "invalid_request",
          `holdMs must be an integer between ${min} and ${max}`,
        );
      }
      if (fields.fenced !== true) {
        return failure(
          400,
          "invalid_request",
          "An explicit lease (holdMs) must be fenced",
        );
      }
    }
    const ttlMs = holdMs !== undefined
      ? holdMs as number
      : this.#ttlOf(fields.ttlMs);
    if (ttlMs instanceof Response) return ttlMs;
    const waitMs = fields.waitMs ?? 0;
    if (
      typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0
    ) {
      return failure(
        400,
        "invalid_request",
        "waitMs must be a non-negative integer",
      );
    }
    // the caller's whole remaining wait: an explicit lease outlasting it is
    // answered at once rather than long-polled
    const budgetMs = fields.budgetMs;
    if (
      budgetMs !== undefined &&
      (typeof budgetMs !== "number" || !Number.isSafeInteger(budgetMs) ||
        budgetMs < 0)
    ) {
      return failure(
        400,
        "invalid_request",
        "budgetMs must be a non-negative integer",
      );
    }
    const catchUp = parseCatchUpRequest(fields.catchUp);
    if (catchUp === "invalid") {
      return failure(
        400,
        "invalid_request",
        "catchUp must be {cursor, anchor?}",
      );
    }
    const refused = await this.#authorizeLock(target);
    if (refused !== undefined) return refused;
    // A kept lease on this key not adopted yet holds it (swamp-club#4258).
    if (this.#deps.locks.adoptionPendingFor(target)) {
      return adoptionPendingResponse();
    }
    const outcome = await this.#deps.locks.acquire({
      principal: this.#caller.principal,
      target,
      ttlMs,
      waitMs,
      signal: req.signal,
      ...(fenced ? { fenced: () => this.#leaseBase(target) } : {}),
      ...(holdMs !== undefined ? { holdMs: holdMs as number } : {}),
      ...(budgetMs !== undefined ? { budgetMs: budgetMs as number } : {}),
    });
    switch (outcome.kind) {
      case "acquired": {
        const page = catchUp === undefined
          ? undefined
          : await this.#lockCatchUp(req, catchUp);
        return Response.json({
          ...outcome.lease,
          ...(page === undefined ? {} : { catchUp: page }),
        }, { status: 201 });
      }
      case "too-many":
        return failure(
          429,
          "too_many_leases",
          "This caller holds too many locks: release some before taking another",
        );
      case "not-kept":
        return withHeaders(
          failure(
            503,
            "lease_not_kept",
            "Serve could not record the lease where its next leader would find it, so it did not grant it; try again",
          ),
          [["Retry-After", "1"]],
        );
      case "held":
        // The caller passed this lock's authorization, so it may take the
        // lock and may know who holds it; heldBy stays for older clients.
        return Response.json({
          code: "lock_held",
          heldBy: outcome.heldBy,
          ...(outcome.holder === undefined ? {} : { holder: outcome.holder }),
          message: heldMessage(fields.lockKey as string, outcome),
        }, { status: 409, headers: { "Retry-After": "1" } });
    }
  }

  /**
   * only locks the caller could take itself, each decided without a refusal
   * audit, since a listing refuses nothing
   */
  async listLocks(req: Request): Promise<Response> {
    const prefix = new URL(req.url).searchParams.get("prefix") ?? "";
    if (prefix.length > 512) {
      return failure(400, "invalid_request", "prefix is too long");
    }
    await this.#catchUp();
    const leases: {
      lockKey: string;
      heldBy: LockHolder;
      expiresAt: string;
      holder: LeaseHolder;
    }[] = [];
    let truncated = false;
    for (const lease of this.#deps.locks.list(prefix)) {
      if (!this.#mayRead([await this.#lockAccessOf(lease.target)])) continue;
      if (leases.length === MAX_LISTED_LEASES) {
        truncated = true;
        break;
      }
      leases.push({
        lockKey: lease.lockKey,
        heldBy: lease.principal === this.#caller.principal ? "caller" : "other",
        expiresAt: lease.expiresAt,
        holder: {
          principal: lease.principal,
          explicit: lease.explicit,
          expiresAt: lease.expiresAt,
        },
      });
    }
    return Response.json({ leases, truncated });
  }

  /**
   * `PUT locks/{leaseId}`: `{ttlMs?}`. Extends the caller's lease, after
   * authorising its lock again: a caller whose grant was revoked loses the
   * lease at its next renewal.
   */
  async renewLock(req: Request, leaseId: string): Promise<Response> {
    const body = await readJson(req, 16 * 1024);
    const fields = typeof body === "object" && body !== null &&
        !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const principal = this.#caller.principal;
    const held = this.#deps.locks.lease(principal, leaseId);
    if (held === undefined) {
      // A kept lease not adopted yet is not lost (swamp-club#4258).
      return this.#deps.locks.leaseAdoptionPending(leaseId)
        ? adoptionPendingResponse()
        : leaseNotFound();
    }
    // `holdMs` makes a fenced lease explicit, or changes its hold: a
    // checkout takes a short lease, records it, then extends it, so a reply
    // lost on the way strands it only briefly (swamp-club#4121).
    const holdMs = fields.holdMs;
    if (holdMs !== undefined) {
      const { min, max } = this.#deps.locks.holdBounds;
      if (
        typeof holdMs !== "number" || !Number.isSafeInteger(holdMs) ||
        holdMs < min || holdMs > max
      ) {
        return failure(
          400,
          "invalid_request",
          `holdMs must be an integer between ${min} and ${max}`,
        );
      }
      if (held.view.fence === undefined) {
        return failure(
          400,
          "invalid_request",
          "Only a fenced lease can be held across commands",
        );
      }
    }
    // An explicit lease is extended by its own hold (swamp-club#4121).
    const ttlMs = (holdMs as number | undefined) ?? held.view.holdMs ??
      this.#ttlOf(fields.ttlMs);
    if (ttlMs instanceof Response) return ttlMs;
    const refused = await this.#authorizeLock(held.target);
    if (refused !== undefined) {
      await this.#deps.locks.release(principal, leaseId);
      return refused;
    }
    const renewed: LeaseView | undefined = await this.#deps.locks.renew(
      principal,
      leaseId,
      ttlMs,
      holdMs as number | undefined,
    );
    return renewed === undefined ? leaseNotFound() : Response.json(renewed);
  }

  /**
   * `DELETE locks`: `{lockKey}`. Ends the lease on a behavior's lock or a
   * run's claim whoever holds it (swamp-club#4195): how an admin recovers
   * an explicit lease its holder abandoned. Admin only. The key is parsed
   * and made canonical once, and that key is both authorised and released.
   */
  async forceReleaseLock(req: Request): Promise<Response> {
    const body = await readJson(req, 16 * 1024);
    const fields = typeof body === "object" && body !== null &&
        !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined;
    const target = parseLockKey(fields?.lockKey);
    if (target === undefined) {
      return failure(
        400,
        "invalid_request",
        'Body must be {"lockKey": "data/{type}/{id}/.lock" or "workflow-run-claims/{runId}/.lock"}',
      );
    }
    const lockKey = lockKeyOf(target);
    if (!this.#writeAuthority().allows("admin", ADMIN_RESOURCE)) {
      this.#auditAdmin(
        "datastore.lock.force-release",
        "lock",
        lockKey,
        "failure",
        "needs admin",
      );
      return failure(
        403,
        "forbidden",
        "Force-releasing another caller's lease needs admin",
      );
    }
    // Its kept lease, not adopted yet, would come back (swamp-club#4258).
    if (this.#deps.locks.adoptionPendingFor(target)) {
      return adoptionPendingResponse();
    }
    let ended;
    try {
      ended = await this.#deps.locks.forceRelease(target);
    } catch (error) {
      if (!(error instanceof LeaseRecordNotRemovedError)) throw error;
      // The lease ended here, but a takeover may bring it back: refused as
      // a temporary failure, so the admin forces the release again.
      this.#auditAdmin(
        "datastore.lock.force-release",
        "lock",
        lockKey,
        "failure",
        "lease ended; its kept record could not be removed",
      );
      return failure(503, LEASE_RECORD_NOT_REMOVED_CODE, error.message);
    }
    this.#auditAdmin(
      "datastore.lock.force-release",
      "lock",
      ended === undefined ? lockKey : `${lockKey} held by ${ended.principal}`,
      "success",
      ended === undefined ? "no lease held" : undefined,
    );
    return Response.json(
      ended === undefined ? { released: false, lockKey } : {
        released: true,
        lockKey,
        heldBy: ended.principal,
      },
    );
  }

  /**
   * `POST quarantine`: `{commit, base, chunks}`. Keeps a change a member's
   * offline flush could not land because its author lacks a grant it needs
   * (swamp-club#4195), for an admin to accept. Serve stamps the caller as
   * its author and authorises the commit again: only a commit that is
   * refused for a grant is kept, so the route is no store for anything
   * else. Bounded per deposit and per author; errors name no detail of
   * what serve holds.
   */
  async depositQuarantine(req: Request): Promise<Response> {
    const store = this.#deps.quarantine;
    if (store === undefined) {
      return failure(
        409,
        "quarantine_unavailable",
        "This server does not keep quarantined changes",
      );
    }
    // Bounded as uploads are (swamp-club#4258): a deposit buffers its whole
    // body, so a caller holds at most the chunk slots' worth at once.
    return await this.#withChunkSlot(() => this.#depositQuarantine(req, store));
  }

  async #depositQuarantine(
    req: Request,
    store: QuarantineStore,
  ): Promise<Response> {
    const body = await readBodyWithLimit(req, MAX_QUARANTINE_REQUEST_BYTES);
    if (body === null) return quarantineTooLarge();
    let commit: Commit;
    let base: { readonly seq: number; readonly txnId?: string };
    let rawChunks: unknown;
    try {
      const fields = JSON.parse(new TextDecoder().decode(body)) as Record<
        string,
        unknown
      >;
      // Canonical before anything reads it: every landed commit carries a
      // lowercase txnId, so a re-cased copy is the same change
      // (swamp-club#4258).
      commit = await withCanonicalTxnId(await Commit.fromJSON(fields.commit));
      base = quarantineBaseOf(fields.base);
      rawChunks = fields.chunks;
    } catch {
      return failure(400, "invalid_request", "Malformed quarantine deposit");
    }
    const txnId = commit.txnId;
    const size = body.byteLength;
    if (!isQuarantineTxnId(txnId) || commit.namespace !== this.#namespace) {
      return failure(400, "invalid_request", "Malformed quarantine deposit");
    }
    await this.#catchUp();
    // A txnId that already landed names a change serve holds: kept again
    // it would be accepted against another commit's seq, misleading the
    // record and the audit trail.
    if (
      await this.#v3.commitStore.landedSeq(
        this.#v3.namespace,
        commit.partition,
        txnId,
      ) !== undefined
    ) {
      return failure(
        409,
        "quarantine_landed",
        "A change whose txnId already landed is not kept",
      );
    }
    const refusal = await authorizeCommit(
      commit.partition,
      commit.ops,
      this.#resolver,
      this.#writeAuthority(),
      "deferred",
    );
    if (refusal.ok || refusal.reason !== "forbidden") {
      return failure(
        409,
        "not_quarantinable",
        "Only a change refused for a grant its author lacks is kept",
      );
    }
    // Only a caller who may read the partition keeps a change to it, as
    // GET partitions/{p}/commits decides: a caller with no stake in it
    // cannot fill the shared caps with changes refused by construction.
    if (
      !this.#mayRead(
        await partitionReadAccessOf(commit.partition, this.#resolver),
      )
    ) {
      return failure(
        403,
        "quarantine_not_readable",
        "Serve keeps a refused change only for a caller who may read its partition",
      );
    }
    // Decoded only once the change is one serve keeps (swamp-club#4258).
    let chunks: QuarantineChunk[];
    try {
      chunks = await quarantineChunksOf(rawChunks);
    } catch {
      return failure(400, "invalid_request", "Malformed quarantine deposit");
    }
    if (
      chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0) >
        MAX_QUARANTINE_DEPOSIT_BYTES
    ) {
      return failure(400, "invalid_request", "Malformed quarantine deposit");
    }
    // Only the chunks the commit names are kept, and every one it names
    // must come with it: serve stores none of an author it no longer trusts.
    if (
      !quarantineCarriesExactly(chunks, new Set(referencedChunks(commit.ops)))
    ) {
      return failure(
        400,
        "invalid_request",
        "A deposit carries exactly the chunks its commit names",
      );
    }
    const principal = this.#caller.principal;
    // The caps are checked and the deposit made with no other deposit in
    // between, so deposits sent together cannot pass them.
    return await withQuarantineLock(store, async () => {
      const existing = await store.find(txnId);
      if (existing !== undefined) {
        if (existing.principal !== principal) {
          return failure(
            409,
            "not_quarantinable",
            "Only a change refused for a grant its author lacks is kept",
          );
        }
        return Response.json({ deposited: true, txnId, duplicate: true });
      }
      const principalKey = await principalKeyOf(principal);
      if (
        !quarantineHasRoom(await store.heldKeys(), principalKey, {
          held: await store.heldBytesOf(principalKey),
          deposit: size,
        })
      ) {
        return failure(
          429,
          "quarantine_full",
          "Serve keeps no more quarantined changes from this caller now; an admin must accept or discard some first",
        );
      }
      await store.deposit(
        {
          txnId,
          partition: commit.partition.toString(),
          principal,
          // The author's membership as serve sees it now: an accept judges
          // the content with the author's access, not the admin's.
          groups: boundedMemberships(this.#caller.access.groups),
          collectives: boundedMemberships(this.#caller.access.collectives),
          reason: boundedQuarantineReason(refusal.message),
          depositedAt: new Date(this.#now()).toISOString(),
          bytes: size,
          state: "held",
        },
        { commit: commit.toJSON(), base, chunks },
      );
      logger
        .info`Kept a change by ${principal} to ${commit.partition} that it lacks a grant for, for an admin to accept`;
      return Response.json({ deposited: true, txnId }, { status: 201 });
    });
  }

  /**
   * `POST quarantine/{txnId}/accept`: lands a kept change (swamp-club#4195).
   * Admin only, checked before anything is read. The change is rebased on
   * what landed meanwhile, as its author's own flush would rebase it, and
   * lands under its txnId as its author: the author's next command finds it
   * landed and settles it. The admin is recorded on the kept record and in
   * serve's audit log, never on the commit. Runs one at a time with
   * deposits and discards, so an accept and a discard of one change never
   * both act.
   */
  async acceptQuarantine(req: Request, rawTxnId: string): Promise<Response> {
    const store = this.#deps.quarantine;
    if (store === undefined) {
      return failure(
        409,
        "quarantine_unavailable",
        "This server does not keep quarantined changes",
      );
    }
    const txnId = rawTxnId.toLowerCase();
    if (!this.#writeAuthority().allows("admin", ADMIN_RESOURCE)) {
      this.#auditAdmin(
        "datastore.quarantine.accept",
        "quarantine",
        txnId,
        "failure",
        "needs admin",
      );
      return failure(
        403,
        "forbidden",
        "Accepting a quarantined change needs admin",
      );
    }
    if (!isQuarantineTxnId(txnId)) {
      return failure(400, "invalid_request", "Not a txnId");
    }
    return await withQuarantineLock(
      store,
      () => this.#accept(req, store, txnId),
    );
  }

  async #accept(
    req: Request,
    store: QuarantineStore,
    txnId: string,
  ): Promise<Response> {
    const record = await store.find(txnId);
    if (record === undefined) {
      return failure(404, "not_found", "No such quarantined change");
    }
    if (record.state === "accepted") {
      return Response.json({ accepted: true, duplicate: true, ...record });
    }
    if (record.state === "discarded") {
      return failure(
        409,
        "quarantine_discarded",
        "An admin discarded that quarantined change; it cannot be accepted",
      );
    }
    const content = await store.content(txnId);
    if (content === undefined) {
      return failure(404, "not_found", "No such quarantined change");
    }
    // A record kept before deposits were canonicalised may hold its commit
    // under a re-cased txnId: it lands under the canonical one, which every
    // landed commit carries (swamp-club#4258).
    const commit = await withCanonicalTxnId(
      await Commit.fromJSON(content.commit),
    );
    // The record and its content are judged by the same canonical txnId and
    // partition the change lands under, and the content must still carry
    // every chunk its commit names: the admin's access never vouches for a
    // chunk the author did not provide.
    if (
      commit.txnId !== txnId ||
      commit.partition.toString() !== record.partition ||
      commit.namespace !== this.#namespace ||
      !quarantineCarriesExactly(
        content.chunks,
        new Set(referencedChunks(commit.ops)),
      )
    ) {
      return failure(
        409,
        "quarantine_corrupt",
        "The quarantined change does not match its record",
      );
    }
    // A kept lease on the partition not adopted yet would let the change
    // land past its holder (swamp-club#4258).
    if (this.#adoptionPendingOn(commit.partition)) {
      return adoptionPendingResponse();
    }
    await this.#catchUp();
    // Landed by an accept whose replication was not confirmed, or that
    // stopped before it marked the record: confirmed and marked now, never
    // landed again (swamp-club#4258).
    let seq = await this.#v3.commitStore.landedSeq(
      this.#v3.namespace,
      commit.partition,
      txnId,
    );
    let report: Pick<OfflineFlushReport, "renumbered" | "latest"> = {
      renumbered: [],
      latest: [],
    };
    if (
      seq !== undefined &&
      !(await this.#landedAs(commit.partition, seq, record.principal))
    ) {
      // Another writer's commit took the txnId: this change never landed,
      // and the record is not marked as if it had.
      this.#auditAccept(record, "failure", "txnId landed by another author");
      return failure(
        409,
        "quarantine_refused",
        "The quarantined change cannot land: another change landed under its txnId",
      );
    }
    if (seq === undefined) {
      await this.#store(content.chunks, req.signal);
      const deposited = new Set(content.chunks.map((chunk) => chunk.sha256));
      const outcome: AcceptOutcome = { landed: false };
      const flushed = await flushOfflineEntries(
        this.#acceptPort(record, deposited, outcome, req.signal),
        [{
          commit,
          unitId: txnId,
          base: { seq: content.base.seq, txnId: content.base.txnId },
          sequence: 0,
          createdAt: Date.parse(record.depositedAt) || this.#now(),
          state: "offline",
        }],
        {
          writer: { host: "serve", pid: Deno.pid, instance: this.#requestId },
          fence: this.#v3.writerFence() ?? 0,
          signal: req.signal,
        },
      );
      if (outcome.initiatorRefused !== undefined) {
        // a record an older CLI wrote names an initiator serve now refuses;
        // nothing can make it land, so the work is run again
        this.#auditAccept(
          record,
          "failure",
          `initiator refused under ${record.principal}'s access: ${outcome.initiatorRefused}`,
        );
        return failure(
          403,
          "quarantine_content_refused",
          `The quarantined change cannot land: its run record does not name its author ${record.principal} as its initiator (${outcome.initiatorRefused}). Discard it with \`swamp datastore quarantine discard ${txnId}\`, then run the work again.`,
        );
      }
      if (outcome.contentRefused !== undefined) {
        // The author's own access refuses what the change carries or
        // names: an admin's accept overrides the write grant it lacked,
        // never what the author may read. Kept held, so an admin can
        // discard it.
        this.#auditAccept(
          record,
          "failure",
          `content refused under ${record.principal}'s access: ${outcome.contentRefused}`,
        );
        return failure(
          403,
          "quarantine_content_refused",
          `The quarantined change cannot land: its author ${record.principal} may not use what it carries or names (${outcome.contentRefused}). Discard it with \`swamp datastore quarantine discard ${txnId}\`.`,
        );
      }
      if (!outcome.landed) {
        this.#auditAccept(record, "failure", outcome.reason ?? outcome.state);
        return flushed.waiting > 0
          ? failure(
            409,
            "quarantine_waiting",
            "A lease covers that behavior now: accept it again once the lease ends",
          )
          : failure(
            409,
            "quarantine_refused",
            `The quarantined change cannot land: ${
              outcome.reason ?? "refused"
            }`,
          );
      }
      report = flushed;
      seq = await this.#v3.commitStore.landedSeq(
        this.#v3.namespace,
        commit.partition,
        txnId,
      );
    }
    const warning = await this.#afterCommit(commit.partition);
    // The kept content goes only once the change it lands is replicated: a
    // leader that loses the lead before then would otherwise leave neither
    // (swamp-club#4258). Kept held, so the accept can be sent again.
    if (this.#deps.ctx.confirmReplicated !== undefined) {
      try {
        await this.#deps.ctx.confirmReplicated();
      } catch (error) {
        const { code, message } = replicationErrorForClient(
          error,
          "internal_error",
        );
        logger
          .warn`Quarantine accept ${txnId} landed but could not be confirmed as replicated (${code}): ${error}`;
        this.#auditAccept(record, "failure", "replication not confirmed");
        return Response.json({ code, message }, { status: 503 });
      }
    }
    const accepted = {
      ...record,
      state: "accepted" as const,
      acceptedBy: this.#caller.principal,
      acceptedAt: new Date(this.#now()).toISOString(),
      ...(seq === undefined ? {} : { seq }),
    };
    await store.markAccepted(accepted);
    this.#auditAccept(record, "success");
    return Response.json({
      accepted: true,
      ...accepted,
      renumbered: report.renumbered,
      latest: report.latest,
      ...(warning === undefined ? {} : { warning }),
    });
  }

  /**
   * `GET quarantine/{txnId}`: whether serve still holds the change
   * `txnId`, accepted it or discarded it (swamp-club#4195), so its author's
   * checkout can settle the entry it keeps. Only its author or an admin is
   * told; anyone else is answered as if serve held none.
   */
  async quarantineState(rawTxnId: string): Promise<Response> {
    const store = this.#deps.quarantine;
    const txnId = rawTxnId.toLowerCase();
    if (store === undefined || !isQuarantineTxnId(txnId)) {
      return failure(404, "not_found", "No such quarantined change");
    }
    const record = await store.find(txnId);
    if (
      record === undefined ||
      (record.principal !== this.#caller.principal &&
        !this.#writeAuthority().allows("admin", ADMIN_RESOURCE))
    ) {
      return failure(404, "not_found", "No such quarantined change");
    }
    return Response.json({ txnId, state: record.state });
  }

  /**
   * `POST quarantine/{txnId}/discard`: discards a kept change so it never
   * lands (swamp-club#4195). Admin only, checked before anything is read,
   * and audited either way. The held content is removed and the record kept,
   * marked discarded with the admin and when: it no longer counts against
   * any cap, and its author's next command settles its entry as declined.
   * A change already accepted cannot be discarded.
   */
  async discardQuarantine(rawTxnId: string): Promise<Response> {
    const store = this.#deps.quarantine;
    if (store === undefined) {
      return failure(
        409,
        "quarantine_unavailable",
        "This server does not keep quarantined changes",
      );
    }
    const txnId = rawTxnId.toLowerCase();
    if (!this.#writeAuthority().allows("admin", ADMIN_RESOURCE)) {
      this.#auditAdmin(
        "datastore.quarantine.discard",
        "quarantine",
        txnId,
        "failure",
        "needs admin",
      );
      return failure(
        403,
        "forbidden",
        "Discarding a quarantined change needs admin",
      );
    }
    if (!isQuarantineTxnId(txnId)) {
      return failure(400, "invalid_request", "Not a txnId");
    }
    return await withQuarantineLock(store, async () => {
      const record = await store.find(txnId);
      if (record === undefined) {
        return failure(404, "not_found", "No such quarantined change");
      }
      if (record.state === "discarded") {
        return Response.json({ discarded: true, duplicate: true, ...record });
      }
      if (record.state === "accepted") {
        return failure(
          409,
          "quarantine_accepted",
          "That quarantined change was accepted and has landed; it cannot be discarded",
        );
      }
      const discarded: QuarantineRecord = {
        ...record,
        state: "discarded",
        discardedBy: this.#caller.principal,
        discardedAt: new Date(this.#now()).toISOString(),
      };
      await store.markDiscarded(discarded);
      this.#auditAdmin(
        "datastore.quarantine.discard",
        "quarantine",
        `${record.partition} ${record.txnId} by ${record.principal}`,
        "success",
      );
      logger
        .info`Discarded the quarantined change ${txnId} by ${record.principal} to ${record.partition}; it never lands`;
      return Response.json({ discarded: true, duplicate: false, ...discarded });
    });
  }

  /**
   * The flush port an accept lands a kept change through: serve's own log,
   * read and written directly, with every commit judged as a forwarded one
   * is: the admin's authority decides the write grant, the author's access
   * decides the content, and the author is stamped.
   */
  #acceptPort(
    record: QuarantineRecord,
    deposited: ReadonlySet<string>,
    outcome: AcceptOutcome,
    signal: AbortSignal,
  ): OfflineFlushPort {
    const v3 = this.#v3;
    const ns = v3.namespace;
    return {
      catchUpPartition: () => this.#catchUp(),
      partitionState: (_ns, partition) =>
        v3.commitStore.partitionState(ns, partition),
      partitionCommits: async (_ns, partition) => {
        const commits: Commit[] = [];
        let from = 1;
        while (true) {
          let page;
          try {
            page = await v3.commitStore.readPartition(ns, partition, from, 500);
          } catch (error) {
            // What was compacted is not read: those versions' times are
            // unknown to the rebase.
            if (
              error instanceof CommitsCompactedError &&
              error.compactedSeq !== undefined && error.compactedSeq >= from
            ) {
              from = error.compactedSeq + 1;
              continue;
            }
            throw error;
          }
          if (page.length === 0) return commits;
          for (const change of page) commits.push(change.commit);
          from = page[page.length - 1].commit.seq + 1;
        }
      },
      head: async (_ns, partition) =>
        (await v3.commitStore.head(ns, partition)).seq,
      send: async (commit) => {
        await this.#landAccepted(commit, record, deposited, outcome, signal);
      },
      encodeMetadata: encodeDataMetadata,
      storeChunks: async (_ns, bytes) => {
        const batch = v3.chunkStore.beginBatch(namespaceOf(v3));
        try {
          const blob = await v3.chunkStore.write(
            namespaceOf(v3),
            bytes,
            signal,
            batch,
          );
          await batch.commit(signal);
          return blob;
        } finally {
          await batch.discard();
        }
      },
      mark: (_keys, state, reason) => {
        outcome.state = state;
        if (reason !== undefined) outcome.reason = reason;
        return Promise.resolve();
      },
      settle: () => {
        outcome.landed = true;
        return Promise.resolve();
      },
    };
  }

  /**
   * Lands one rebased commit of a kept change, as `commit` does a forwarded
   * one: content judged first, then authorised again under the forwarded
   * lock with the lease that covers the partition, stamped as its author.
   * The admin's authority answers only for the write grant the author
   * lacked; everything the commit carries or names (expression, vault and
   * data references, chunks it did not deposit) is judged with the access
   * of the author it is stamped as, so an accept never lends the admin's
   * reads to the author.
   */
  async #landAccepted(
    commit: Commit,
    record: QuarantineRecord,
    deposited: ReadonlySet<string>,
    outcome: AcceptOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const partition = commit.partition;
    const ops = commit.ops;
    await this.#catchUp();
    const resolver = memoized(serveResolver(this.#deps.ctx, this.#v3));
    const author = authorAccessOf(record, this.#caller.access.sourceIp);
    // Proof of possession, as a forwarded commit gives it: a chunk the
    // deposit did not carry is the rebase restating the current latest,
    // and the author must be able to read it. Otherwise serve answers as it
    // answers a member's own flush, chunk_not_provided, and the flush sends
    // the change again without the restatement; the author is never lent a
    // read they lack.
    // Decided once per hash: the content check below reads these, so it
    // never spends the budget again on a chunk this loop vouched for
    // (swamp-club#4260).
    const named = referencedChunks(ops);
    const possession = this.#commitVouchBudget(
      named.filter((hash) => !deposited.has(hash)).length,
    );
    const vouched = new Set<string>();
    for (const hash of named) {
      if (deposited.has(hash)) continue;
      if (
        await this.#mayReference(hash, possession, resolver, author) ===
          "vouched"
      ) {
        vouched.add(hash);
        continue;
      }
      throw new ServeUpstreamError(
        403,
        "chunk_not_provided",
        `The change names chunk ${hash}, which its author neither deposited nor may read`,
      );
    }
    const content = new ForwardedContentAuthority({
      ctx: this.#deps.ctx,
      v3: this.#v3,
      partition,
      caller: author,
      requestId: this.#requestId,
      resolver,
      // Every undeposited chunk the commit names was vouched for above, or
      // the accept stopped there; anything else spends the same budget.
      possesses: async (hash) =>
        deposited.has(hash) || vouched.has(hash) ||
        (await this.#mayReference(hash, possession, resolver, author) ===
          "vouched"),
      signal,
    });
    const checked = await authorizeCommit(
      partition,
      ops,
      resolver,
      this.#writeAuthority(),
      content,
    );
    if (!checked.ok) {
      if (checked.reason === "content-refused") {
        outcome.contentRefused = checked.message;
      }
      if (checked.reason === RUN_INITIATOR_MISMATCH_REASON) {
        outcome.initiatorRefused = checked.message;
      }
      throw refusedError(checked);
    }
    const request = {
      partition,
      txnId: commit.txnId,
      expectedSeq: commit.seq - 1,
      principal: record.principal,
      ops,
    };
    const landed = await withForwardedLock(this.#v3, async () => {
      await this.#catchUp();
      const recheck = await authorizeCommit(
        partition,
        ops,
        memoized(serveResolver(this.#deps.ctx, this.#v3)),
        this.#writeAuthority(),
        "deferred",
      );
      if (!recheck.ok) return recheck;
      if (!(await content.unchanged())) return "content-changed" as const;
      // A kept lease on the partition not adopted yet covers it, as a live
      // one does (swamp-club#4258).
      if (this.#adoptionPendingOn(partition)) return "lease-lost" as const;
      const lease = this.#leaseOpFor(partition, undefined);
      if (lease === "lost") return "lease-lost" as const;
      try {
        return await commitForwarded(this.#v3, request, signal);
      } catch (error) {
        if (error instanceof StaleSeqError) return "seq-gap" as const;
        throw error;
      }
    });
    if (landed === "seq-gap" || landed === "content-changed") {
      throw new CommitRejectedError(
        "seq-gap",
        `Partition ${partition} moved while the change was judged`,
      );
    }
    if (landed === "lease-lost") {
      throw new CommitRejectedError(
        "lease-lost",
        `A lease covers ${partition} now`,
      );
    }
    if ("ok" in landed) throw refusedError(landed);
    this.#deps.ledger.release(this.#storageNamespace, [...deposited]);
  }

  #auditAccept(
    record: QuarantineRecord,
    outcome: "success" | "failure",
    detail?: string,
  ): void {
    this.#auditAdmin(
      "datastore.quarantine.accept",
      "quarantine",
      `${record.partition} ${record.txnId} by ${record.principal}`,
      outcome,
      detail,
    );
  }

  /** Records an admin action on serve's datastore in the audit log. */
  #auditAdmin(
    action: string,
    resourceKind: string,
    resourceName: string,
    outcome: "success" | "failure",
    detail?: string,
  ): void {
    const emitter = this.#deps.ctx.auditEmitter;
    if (emitter === undefined) return;
    const principal = this.#caller.access.principal;
    emitter.emit(buildAuditEvent({
      instanceId: this.#deps.ctx.instanceId ?? "unknown",
      category: "admin",
      stage: "response",
      outcome,
      action,
      resourceKind,
      resourceName,
      principalKind: principal?.kind ?? "anonymous",
      principalId: principal?.id ?? "anonymous",
      initiatedBy: principal
        ? resolveDisplayPrincipal(principal, this.#deps.ctx)
        : "ghost",
      actor: resolveActorIdentity(
        principal,
        this.#deps.ctx.resolvedUserNames,
        this.#caller.access.loginIdentity,
      ),
      client: this.#caller.access.client,
      sourceIp: this.#caller.access.sourceIp,
      requestId: this.#requestId,
      ...(detail === undefined ? {} : { detail }),
    }));
  }

  /** `DELETE locks/{leaseId}`: releases the caller's lease. */
  async releaseLock(leaseId: string): Promise<Response> {
    if (await this.#deps.locks.release(this.#caller.principal, leaseId)) {
      return Response.json({ released: true });
    }
    // A kept lease not adopted yet is not lost (swamp-club#4258).
    return this.#deps.locks.leaseAdoptionPending(leaseId)
      ? adoptionPendingResponse()
      : leaseNotFound();
  }

  /** Whether the commit at `seq` in `partition` landed as `principal`. */
  async #landedAs(
    partition: PartitionKey,
    seq: number,
    principal: string,
  ): Promise<boolean> {
    let page;
    try {
      page = await this.#v3.commitStore.readPartition(
        this.#v3.namespace,
        partition,
        seq,
        1,
      );
    } catch (error) {
      // Compacted since: its author can no longer be read, and another
      // writer may have taken the txnId after the deposit. Refused rather
      // than marked accepted over a change that may never have landed; the
      // record stays held for an admin to discard.
      if (error instanceof CommitsCompactedError) return false;
      throw error;
    }
    const [landed] = page;
    return landed?.commit.seq === seq &&
      landed.commit.principal === principal;
  }

  /**
   * Whether a write to `partition` must wait for the kept lease that may
   * cover it to be adopted (swamp-club#4258).
   */
  #adoptionPendingOn(partition: PartitionKey): boolean {
    return this.#deps.locks.adoptionPendingFor(
      lockTargetOfPartition(partition),
    );
  }

  /**
   * The lease op serve stamps on a commit to `partition` naming `named`
   * (swamp-club#4121), or "lost" when the commit is refused: a named lease
   * must be live, fenced, the caller's, and cover exactly this partition,
   * and a partition a live fenced lease covers takes only commits that name
   * it. Undefined for an unleased commit to a partition no fenced lease
   * covers, which keeps today's rules. The fence is serve's, never the
   * client's.
   */
  #leaseOpFor(
    partition: PartitionKey,
    named: string | undefined,
  ): LeaseOp | "lost" | undefined {
    const target = lockTargetOfPartition(partition);
    const live = target === undefined
      ? undefined
      : this.#deps.locks.fencedLeaseOn(target);
    // A run's claim is held only for a load, decision and save, while the
    // run's owner checkpoints its record throughout: a claim does not
    // refuse the owner's unleased commits. A behavior's lease does.
    if (named === undefined) {
      return live === undefined || target?.kind === "workflow-run"
        ? undefined
        : "lost";
    }
    if (
      live === undefined || live.leaseId !== named ||
      live.principal !== this.#caller.principal
    ) {
      return "lost";
    }
    return leaseOp({ holder: live.leaseId, fence: live.fence });
  }

  /**
   * The lease fence and version marks of the partition `target`'s lease
   * covers, read under its lock. A run serve does not hold yet has no
   * partition: its fence starts from what this process issued.
   */
  async #leaseBase(target: LockTarget): Promise<LeaseBase> {
    return await leaseBaseOf(
      this.#v3,
      this.#deps.ctx.repoContext.workflowRunRepo,
      target,
    );
  }

  /** A TTL within the leases' bounds, or the 400 refusing it. */
  #ttlOf(value: unknown): number | Response {
    const { min, max } = this.#deps.locks.ttlBounds;
    const ttlMs = value ?? Math.min(Math.max(DEFAULT_LOCK_TTL_MS, min), max);
    if (
      typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) ||
      ttlMs < min || ttlMs > max
    ) {
      return failure(
        400,
        "invalid_request",
        `ttlMs must be an integer between ${min} and ${max}`,
      );
    }
    return ttlMs;
  }

  /**
   * Undefined when the caller may hold `target`'s lock, else the 403. A
   * lock is held to write the aggregate, so it needs what a write to the
   * aggregate's partition needs at least (`partitionWriteAccessOf`): `run`
   * on the behavior, admin for a control-plane or restricted type, and for
   * a run `run` on its workflow. A behavior or run serve does not know is
   * decided on its id, so only a wildcard grant matches it.
   */
  async #authorizeLock(target: LockTarget): Promise<Response | undefined> {
    await this.#catchUp();
    const required = await this.#lockAccessOf(target);
    if (this.#writeAuthority().allows(required.action, required.resource)) {
      return undefined;
    }
    return failure(
      403,
      "forbidden",
      `Holding this lock needs ${required.action} on ${required.resource.kind}:${required.resource.name}`,
    );
  }

  /** What holding `target`'s lock needs: what a write to its partition does. */
  async #lockAccessOf(target: LockTarget): Promise<RequiredAccess> {
    let required: RequiredAccess;
    if (target.kind === "model") {
      required = await partitionWriteAccessOf(
        partitionOf({
          kind: "model",
          type: ModelType.create(target.modelType),
          id: target.modelId,
        }),
        this.#resolver,
      );
    } else {
      // A run's claim is taken only for a run whose record serve already
      // holds (a resume or take-over: the client's run.create commit lands
      // first). A run serve does not know is decided on its id, so only a
      // wildcard grant holds it; claiming before the record lands would
      // need the record's workflow here instead (swamp-club#3985).
      const found = await this.#deps.ctx.repoContext.workflowRunRepo
        .findGlobalById(createWorkflowRunId(target.runId));
      required = found === null
        ? {
          action: "run",
          resource: unresolvedAccessResource("workflow", target.runId),
        }
        : await partitionWriteAccessOf(
          partitionOf({
            kind: "run",
            workflowId: found.workflowId,
            runId: target.runId,
          }),
          this.#resolver,
        );
    }
    return required;
  }

  /** A failure is a warning: the commit has landed. */
  async #afterCommit(partition: PartitionKey): Promise<string | undefined> {
    const { ctx } = this.#deps;
    try {
      // No catalog invalidate: it would make the read model replay every commit.
      await this.#catchUp();
      const identity = partition.identity;
      if (identity.kind === "model" && isIntegrationModelType(identity.type)) {
        await ctx.integrationDirectory?.reload();
      } else if (
        identity.kind === "model" && isDelegationModelType(identity.type)
      ) {
        await ctx.delegationDirectory?.reload();
      } else if (
        identity.kind === "model" && isControlPlaneModelType(identity.type)
      ) {
        await ctx.policySnapshotLoader?.load();
      }
      return undefined;
    } catch (error) {
      logger
        .warn`A forwarded commit to ${partition.toString()} landed, but catching serve up failed: ${error}`;
      return "catch_up_failed";
    }
  }

  #vouchBudget(): VouchBudget {
    const limits = this.#deps.vouchLimits;
    return this.#deps.vouchBudget?.() ??
      new VouchBudget(
        limits?.partitions ?? MAX_VOUCH_PARTITIONS,
        limits?.commits ?? MAX_VOUCH_COMMITS,
      );
  }

  /**
   * The budget a commit's possession checks get: at least the 64 partition
   * checks per chunk it does not carry that a commit had before
   * swamp-club#4260, so a commit that landed then is never refused for the
   * budget now. A commit names at most {@link MAX_CHUNKS_PER_COMMIT} chunks
   * it does not carry, which bounds it.
   */
  #commitVouchBudget(uncarried: number): VouchBudget {
    const limits = this.#deps.vouchLimits;
    return this.#deps.vouchBudget?.() ??
      new VouchBudget(
        Math.max(
          limits?.partitions ?? MAX_VOUCH_PARTITIONS,
          REFERENCING_PARTITIONS_PAGE * uncarried,
        ),
        limits?.commits ?? MAX_VOUCH_COMMITS,
      );
  }

  #catchUp(): Promise<void> {
    let coalescer = catchUps.get(this.#v3);
    if (coalescer === undefined) {
      const v3 = this.#v3;
      coalescer = new CatchUpCoalescer(() => v3.catchUp());
      catchUps.set(v3, coalescer);
    }
    return coalescer.catchUp();
  }

  /**
   * Whether the caller may name `sha256` in a commit or read it: it sent
   * it within the grace window, or a partition it may read references it.
   * Every referencing partition is paged through until one vouches
   * (swamp-club#4260), within `budget`: a decision the budget cannot finish
   * is `undecided`, never `refused`, so it is not answered as missing.
   */
  async #mayReference(
    sha256: string,
    budget: VouchBudget,
    resolver: AggregateResourceResolver = this.#resolver,
    as?: AccessCaller,
  ): Promise<Vouch> {
    if (
      this.#deps.ledger.holds(
        as === undefined ? this.#caller.principal : principalLabelOf(as) ?? "",
        this.#storageNamespace,
        sha256,
        this.#now(),
      )
    ) {
      return "vouched";
    }
    let undecided = false;
    let after: string | undefined;
    for (;;) {
      const partitions = await this.#v3.commitStore.partitionsReferencing(
        this.#namespace,
        sha256,
        REFERENCING_PARTITIONS_PAGE,
        after,
      );
      for (const partition of partitions) {
        if (!budget.spendPartition()) return "undecided";
        const identity = partition.identity;
        const vouch =
          identity.kind === "config" && identity.definitionKind === "model"
            ? await this.#mayReadDefinitionChunk(
              partition,
              identity.name,
              sha256,
              budget,
              resolver,
              as,
            )
            : this.#mayRead(
                await partitionReadAccessOf(partition, resolver),
                as,
              )
            ? "vouched"
            : "refused";
        if (vouch === "vouched") return "vouched";
        if (vouch === "undecided") undecided = true;
      }
      if (partitions.length < REFERENCING_PARTITIONS_PAGE) break;
      after = partitions[partitions.length - 1].toString();
    }
    return undecided ? "undecided" : "refused";
  }

  /**
   * Whether a behavior definition's config partition vouches for `sha256`.
   * Same-named definitions of several types share the partition, a
   * control-plane one among them, so the partition as a whole decides
   * nothing (swamp-club#3938). In order:
   *
   * - a record live in it now names the chunk and the caller may read it,
   *   decided by the type its key names, as before swamp-club#4260; skipped
   *   while serve's read model is not complete, never waited on;
   * - a stored commit names it and the caller may read that commit, as the
   *   changes feed and `GET commits` decide it, newest first;
   * - a compacted base record names it and the caller may read that
   *   record, as `GET base` decides it.
   *
   * History counts, not only what is live: a member catching up past a
   * superseded version needs its chunk (swamp-club#4260). A commit budget
   * that runs out without a vouch is refused, as a superseded chunk was
   * before: answering undecided would tell a caller whether guessed content
   * sits in history behind commits it may read, a same-named definition's
   * of another type among them.
   */
  async #mayReadDefinitionChunk(
    partition: PartitionKey,
    name: string,
    sha256: string,
    budget: VouchBudget,
    resolver: AggregateResourceResolver,
    as?: AccessCaller,
  ): Promise<Vouch> {
    let records;
    try {
      records = await this.#v3.readModel.liveRecords(
        this.#namespace,
        partition,
      );
    } catch (error) {
      if (!(error instanceof ReadModelIncompleteError)) throw error;
      records = [];
    }
    for (const record of records) {
      if (
        record.content.kind === "blob" &&
        record.content.blob.chunkHashes().includes(sha256) &&
        this.#mayRead([
          await definitionRecordReadAccessOf(name, record.key, resolver),
        ], as)
      ) {
        return "vouched";
      }
    }
    const store = this.#v3.commitStore;
    // A compaction between the commits and the base can move a commit
    // naming the chunk into the base already read: decided again once, and
    // undecided if the point moves twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      const point = await store.compactionPoint();
      let end = (await store.head(this.#namespace, partition)).seq;
      while (end >= 1) {
        // Each page is sized to the commits the budget has left, so no
        // more are read than it allows.
        const left = budget.commitsLeft;
        if (left <= 0) return "refused";
        let start = Math.max(
          1,
          end - Math.min(DEFINITION_COMMITS_PAGE, left) + 1,
        );
        let page;
        try {
          page = await store.readPartition(
            this.#namespace,
            partition,
            start,
            end - start + 1,
          );
        } catch (error) {
          if (!(error instanceof CommitsCompactedError)) throw error;
          // Everything at or below the compacted seq is in the base. Never
          // thrown on: its message names the partition.
          if (
            error.compactedSeq === undefined || error.compactedSeq < start ||
            error.compactedSeq >= end
          ) {
            break;
          }
          start = error.compactedSeq + 1;
          try {
            page = await store.readPartition(
              this.#namespace,
              partition,
              start,
              end - start + 1,
            );
          } catch (again) {
            // Compacted again meanwhile: on to the base, and the moved
            // compaction point below decides again or answers undecided.
            if (again instanceof CommitsCompactedError) break;
            throw again;
          }
        }
        for (let i = page.length - 1; i >= 0; i--) {
          const { commit } = page[i];
          if (!budget.spendCommit()) return "refused";
          if (
            commit.chunkRefs().includes(sha256) &&
            this.#mayRead(
              await commitReadAccessOf(partition, commit.ops, resolver),
              as,
            )
          ) {
            return "vouched";
          }
        }
        end = start - 1;
      }
      // Not budgeted: one config partition's base holds a record per type
      // of definition sharing the name, a handful at most.
      const keys = await store.baseRecordKeysNaming(
        this.#namespace,
        partition,
        sha256,
      );
      for (const key of keys) {
        if (
          this.#mayRead(
            await baseRecordReadAccessOf(
              partition,
              RecordKey.create(key),
              resolver,
            ),
            as,
          )
        ) {
          return "vouched";
        }
      }
      if (await store.compactionPoint() === point) return "refused";
    }
    // Undecided, never refused: a refusal reads as missing, and this chunk
    // may well be readable (swamp-club#4260).
    return "undecided";
  }

  async #mayReadCommit(
    partition: PartitionKey,
    ops: readonly Op[],
  ): Promise<boolean> {
    return this.#mayRead(
      await commitReadAccessOf(partition, ops, this.#resolver),
    );
  }

  /**
   * Decides reads without auditing each one: they filter, not refuse. `as`
   * decides for another caller than the request's: a kept change's author.
   */
  #mayRead(required: readonly RequiredAccess[], as?: AccessCaller): boolean {
    if (as !== undefined) {
      return required.every(({ action, resource }) =>
        callerResourceDecider(as, action, this.#deps.ctx)(resource)
      );
    }
    return required.every(({ action, resource }) => {
      let decide = this.#readers.get(action);
      if (decide === undefined) {
        decide = callerResourceDecider(
          this.#caller.access,
          action,
          this.#deps.ctx,
        );
        this.#readers.set(action, decide);
      }
      return decide(resource);
    });
  }

  #writeAuthority(): CallerAuthority {
    return {
      allows: (action, resource, every) =>
        every === true
          ? isCallerAuthorizedForAll(
            this.#caller.access,
            this.#requestId,
            action,
            resource.kind,
            this.#deps.ctx,
          )
          : isCallerAuthorized(
            this.#caller.access,
            this.#requestId,
            action,
            resource,
            this.#deps.ctx,
          ),
    };
  }

  /**
   * Reads and verifies a commit's carried chunks in order, storing each while
   * the next is read, then makes them durable together and records them.
   * Each is reserved in the upload ledger before it is read. Resolves with
   * their hashes, or a 429 once the caller's quota or entry cap is spent.
   */
  async #ingestCarried(
    reader: FramedReader,
    declared: readonly { sha256: string; size: number }[],
    signal: AbortSignal,
    last = true,
  ): Promise<Set<string> | Response> {
    const reservations: UploadReservation[] = [];
    const staged = new Map<string, UploadReservation>();
    const batch = this.#v3.chunkStore.beginBatch(namespaceOf(this.#v3));
    const failed = new AbortController();
    const puts = AbortSignal.any([signal, failed.signal]);
    const inFlight = new Set<Promise<void>>();
    try {
      for (const chunk of declared) {
        failed.signal.throwIfAborted();
        // What this request reserved counts too, so requests in flight
        // together cannot pass the quota or the entry cap.
        const admission = this.#deps.ledger.reserve(
          this.#caller.principal,
          chunk.size,
          this.#now(),
        );
        if (!admission.allowed) return uploadQuotaExceeded();
        reservations.push(admission.reservation);
        while (inFlight.size >= CARRIED_PUT_CONCURRENCY) {
          await Promise.race(inFlight);
        }
        failed.signal.throwIfAborted();
        const release = await carriedBytesBudget.acquire(
          budgetedBytesOf(chunk.size),
          puts,
        );
        let verified: VerifiedChunk;
        try {
          verified = await ingestChunk(
            reader,
            chunk,
            { maxChunkBytes: this.#maxChunkBytes() },
            puts,
          );
        } catch (error) {
          release();
          throw error;
        }
        const reservation = admission.reservation;
        const put: Promise<void> = batch.put(
          verified.sha256,
          verified.bytes,
          puts,
        ).then(
          () => {
            if (!staged.has(verified.sha256)) {
              staged.set(verified.sha256, reservation);
            }
          },
          // the first failure is the reason the others see
          (error) => failed.abort(error),
        ).finally(() => {
          release();
          inFlight.delete(put);
        });
        inFlight.add(put);
      }
      await Promise.all(inFlight);
      failed.signal.throwIfAborted();
      // a batch's later commits follow this one's chunks
      if (last) await reader.assertEnd(signal);
      if (staged.size === 0) return new Set();
      await batch.commit(signal);
      // Recorded once durable: a batch discarded on a later failure leaves
      // nothing counting toward the quota.
      for (const [sha256, reservation] of staged) {
        this.#deps.ledger.record(
          reservation,
          this.#storageNamespace,
          sha256,
          this.#now(),
        );
      }
      return new Set(staged.keys());
    } finally {
      failed.abort(new Error("The carried chunks' request has ended"));
      await Promise.allSettled([...inFlight]);
      for (const reservation of reservations) reservation.cancel();
      await batch.discard();
    }
  }

  async #store(
    chunks: readonly { sha256: string; bytes: Uint8Array }[],
    signal: AbortSignal,
  ): Promise<void> {
    if (chunks.length === 0) return;
    const batch = this.#v3.chunkStore.beginBatch(namespaceOf(this.#v3));
    try {
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const chunk = chunks[next++];
          await batch.put(chunk.sha256, chunk.bytes, signal);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(CARRIED_PUT_CONCURRENCY, chunks.length) },
          worker,
        ),
      );
      await batch.commit(signal);
    } finally {
      await batch.discard();
    }
  }

  async #withChunkSlot<T>(fn: () => Promise<T>): Promise<T | Response> {
    const principal = this.#caller.principal;
    const inFlight = chunkRequestsInFlight.get(principal) ?? 0;
    if (inFlight >= MAX_CONCURRENT_CHUNK_REQUESTS) {
      return tooManyRequests(1);
    }
    chunkRequestsInFlight.set(principal, inFlight + 1);
    try {
      return await fn();
    } finally {
      const left = (chunkRequestsInFlight.get(principal) ?? 1) - 1;
      if (left <= 0) chunkRequestsInFlight.delete(principal);
      else chunkRequestsInFlight.set(principal, left);
    }
  }

  #maxChunkBytes(): number {
    return this.#v3.storage.capabilities().maxChunkBytes;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

/** Forwarded commits of each datastore, one at a time. */
const forwardedLocks = new WeakMap<V3Datastore, Promise<unknown>>();

/**
 * Runs `fn` once every forwarded commit to `v3` before it has finished:
 * the check of a key's owner and the append that relies on it are not
 * interleaved with another forwarded commit's.
 */
async function withForwardedLock<T>(
  v3: V3Datastore,
  fn: () => Promise<T>,
): Promise<T> {
  const before = forwardedLocks.get(v3) ?? Promise.resolve();
  const run = before.then(fn);
  const tail = run.catch(() => {});
  forwardedLocks.set(v3, tail);
  try {
    return await run;
  } finally {
    if (forwardedLocks.get(v3) === tail) forwardedLocks.delete(v3);
  }
}

/** Deposits to each quarantine store, one at a time. */
const quarantineLocks = new WeakMap<QuarantineStore, Promise<unknown>>();

/**
 * Runs `fn` once every deposit to `store` before it has finished: a
 * deposit's cap check and its write are not interleaved with another's.
 */
async function withQuarantineLock<T>(
  store: QuarantineStore,
  fn: () => Promise<T>,
): Promise<T> {
  const before = quarantineLocks.get(store) ?? Promise.resolve();
  const run = before.then(fn);
  const tail = run.catch(() => {});
  quarantineLocks.set(store, tail);
  try {
    return await run;
  } finally {
    if (quarantineLocks.get(store) === tail) quarantineLocks.delete(store);
  }
}

/** Runs catch-ups one at a time; a request made during one waits for the next. */
class CatchUpCoalescer {
  #running: Promise<void> | undefined;
  #next: Promise<void> | undefined;

  constructor(private readonly run: () => Promise<void>) {}

  catchUp(): Promise<void> {
    // A catch-up already running may have started before the caller's
    // commit landed, so the caller waits for the one after it, which every
    // caller arriving meanwhile shares.
    if (this.#running === undefined) {
      this.#running = this.run().finally(() => {
        this.#running = undefined;
      });
      return this.#running;
    }
    this.#next ??= this.#running.catch(() => {}).then(() => {
      this.#next = undefined;
      return this.catchUp();
    });
    return this.#next;
  }
}

/**
 * the most bytes of commits a lock reply carries for the caller's catch-up;
 * the rest is read with GET changes
 */
export const LOCK_CATCH_UP_BYTES = 4 * 1024 * 1024;

interface ChangeEntryJson {
  readonly cursor: number;
  readonly commit: unknown;
}

interface FeedAnchorJson {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
}

type AnchorVerdict =
  | { readonly verdict: "held" | "unchecked" }
  | { readonly verdict: "behind"; readonly serveHead: number }
  | { readonly verdict: "other-commit"; readonly serveTxnId: string };

interface CatchUpRequestJson {
  readonly cursor: number;
  readonly anchor?: FeedAnchorJson;
}

function parseFeedAnchor(value: unknown): FeedAnchorJson | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { namespace, partition, seq, txnId } = value as Record<
    string,
    unknown
  >;
  if (
    typeof namespace !== "string" || typeof partition !== "string" ||
    typeof txnId !== "string" || typeof seq !== "number" ||
    !Number.isSafeInteger(seq) || seq < 1
  ) {
    return undefined;
  }
  return { namespace, partition, seq, txnId };
}

function parseAnchorParams(
  params: URLSearchParams,
): FeedAnchorJson | "invalid" | undefined {
  const names = [
    "anchorNamespace",
    "anchorPartition",
    "anchorSeq",
    "anchorTxnId",
  ];
  const present = names.filter((name) => params.has(name));
  if (present.length === 0) return undefined;
  if (present.length !== names.length) return "invalid";
  return parseFeedAnchor({
    namespace: params.get("anchorNamespace"),
    partition: params.get("anchorPartition"),
    seq: nonNegative(params.get("anchorSeq") ?? ""),
    txnId: params.get("anchorTxnId"),
  }) ?? "invalid";
}

function parseCatchUpRequest(
  value: unknown,
): CatchUpRequestJson | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "invalid";
  }
  const { cursor, anchor } = value as Record<string, unknown>;
  if (
    typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0
  ) {
    return "invalid";
  }
  if (anchor === undefined) return { cursor };
  const parsed = parseFeedAnchor(anchor);
  return parsed === undefined ? "invalid" : { cursor, anchor: parsed };
}

interface LandedCommit {
  readonly partition: PartitionKey;
  readonly result: ForwardedCommitResult;
  readonly warning?: string;
}

interface BatchHeader {
  readonly items: readonly { readonly partition: string }[];
  readonly release?: string;
}

/** one commit's answer in a batch: what the single route would have said */
interface BatchItemReply {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: string;
}

function parseBatchHeader(value: unknown): BatchHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the batch header must be a JSON object");
  }
  const json = value as Record<string, unknown>;
  for (const field of Object.keys(json)) {
    if (field !== "items" && field !== "release") {
      throw new Error(`the batch header does not take the field '${field}'`);
    }
  }
  const { items, release } = json;
  if (
    !Array.isArray(items) || items.length === 0 ||
    items.length > MAX_BATCH_COMMITS
  ) {
    throw new Error(
      `items must hold between 1 and ${MAX_BATCH_COMMITS} commits`,
    );
  }
  const parsed = items.map((item) => {
    if (
      typeof item !== "object" || item === null || Array.isArray(item) ||
      Object.keys(item).some((key) => key !== "partition") ||
      typeof (item as { partition?: unknown }).partition !== "string"
    ) {
      throw new Error("each item names only its partition");
    }
    return { partition: (item as { partition: string }).partition };
  });
  if (
    release !== undefined &&
    (typeof release !== "string" || !UUID.test(release))
  ) {
    throw new Error("release must be a lease id: a lowercase UUID");
  }
  return {
    items: parsed,
    ...(release === undefined ? {} : { release: release as string }),
  };
}

async function batchItemReplyOf(response: Response): Promise<BatchItemReply> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a plain-text refusal is passed on as text
  }
  const retryAfter = response.headers.get("retry-after");
  return {
    status: response.status,
    body,
    ...(retryAfter === null ? {} : { retryAfter }),
  };
}

interface CommitEnvelope {
  readonly expectedSeq: number;
  readonly txnId: string;
  readonly fence?: number;
  /** The model lease the commit is made under (swamp-club#4121): its id. */
  readonly lease?: string;
  readonly ops: readonly unknown[];
  readonly chunks: readonly { sha256: string; size: number }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = new Set([
  "expectedSeq",
  "txnId",
  "fence",
  "lease",
  "ops",
  "chunks",
]);

function parseEnvelope(value: unknown): CommitEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the envelope must be a JSON object");
  }
  const json = value as Record<string, unknown>;
  for (const field of Object.keys(json)) {
    // Whatever serve stamps (principal, writer, namespace, seq) is never
    // taken from the client.
    if (!ENVELOPE_FIELDS.has(field)) {
      throw new Error(`the envelope does not take the field '${field}'`);
    }
  }
  const { expectedSeq, txnId, fence, lease, ops, chunks } = json;
  if (
    typeof expectedSeq !== "number" || !Number.isSafeInteger(expectedSeq) ||
    expectedSeq < 0
  ) {
    throw new Error("expectedSeq must be a non-negative integer");
  }
  if (typeof txnId !== "string" || !UUID.test(txnId)) {
    throw new Error("txnId must be a lowercase UUID");
  }
  if (
    fence !== undefined &&
    (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 0)
  ) {
    throw new Error("fence must be a non-negative integer");
  }
  if (lease !== undefined && (typeof lease !== "string" || !UUID.test(lease))) {
    throw new Error("lease must be a lease id: a lowercase UUID");
  }
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_COMMIT_OPS) {
    throw new Error(`ops must hold between 1 and ${MAX_COMMIT_OPS} ops`);
  }
  const declared = chunks ?? [];
  if (!Array.isArray(declared) || declared.length > MAX_CHUNKS_PER_COMMIT) {
    throw new Error(`chunks must hold at most ${MAX_CHUNKS_PER_COMMIT} chunks`);
  }
  for (const chunk of declared) {
    const { sha256, size } = (chunk ?? {}) as {
      sha256?: unknown;
      size?: unknown;
    };
    if (
      typeof chunk !== "object" || chunk === null ||
      typeof sha256 !== "string" || !isSha256Hex(sha256) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 0
    ) {
      throw new Error(
        "each chunk must be {sha256, size}: a SHA-256 hex digest and a non-negative integer",
      );
    }
  }
  return {
    expectedSeq,
    txnId,
    ...(fence === undefined ? {} : { fence: fence as number }),
    ...(lease === undefined ? {} : { lease: lease as string }),
    ops,
    chunks: declared as { sha256: string; size: number }[],
  };
}

function referencedChunks(ops: readonly Op[]): string[] {
  const hashes = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "put" || !("blob" in op.content)) continue;
    for (const hash of chunkHashesOf(op.content.blob)) hashes.add(hash);
  }
  return [...hashes];
}

function chunkHashesOf(blob: BlobRef): readonly string[] {
  return blob.chunkHashes();
}

function parsePartition(segment: string): PartitionKey | undefined {
  try {
    return PartitionKey.parse(segment);
  } catch {
    return undefined;
  }
}

/** A refusal as the flush reads it: the error serve's reply maps to. */
function refusedError(refusal: CommitRefusal): ServeCommitRefusedError {
  return new ServeCommitRefusedError(
    refusalCode(refusal),
    refusal.reason,
    refusal.opIndex,
    refusal.message,
  );
}

/**
 * A version's `metadata.yaml` bytes, as the data repository writes them:
 * what an accepted change's rebase restates and renumbers.
 */
function encodeDataMetadata(metadata: DataMetadata): Uint8Array {
  return new TextEncoder().encode(
    stringifyYaml(
      JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
    ),
  );
}

/** What an accept learned while landing a kept change. */
interface AcceptOutcome {
  landed: boolean;
  state?: string;
  reason?: string;
  /** Set when the author's own access refused the change's content. */
  contentRefused?: string;
  /** Set when its run record names someone other than its author. */
  initiatorRefused?: string;
}

/**
 * `commit` under its lowercase txnId (swamp-club#4258): the form every
 * landed commit carries, as the commit route refuses any other.
 */
async function withCanonicalTxnId(commit: Commit): Promise<Commit> {
  const txnId = commit.txnId.toLowerCase();
  return txnId === commit.txnId
    ? commit
    : await Commit.fromJSON({ ...commit.toJSON(), txnId });
}

/** A caller's memberships as a record keeps them: bounded. */
function boundedMemberships(names: readonly string[]): string[] {
  return names.slice(0, MAX_RECORDED_MEMBERSHIPS)
    .filter((name) => name.length > 0 && name.length <= 256);
}

/**
 * The access a kept change's content is judged with: its author's, as serve
 * knows it now. The principal is the one the change is stamped as, so the
 * identity that decides the content is the identity it lands as, and the
 * decision adds the groups serve itself keeps for it, read from the current
 * policy. The identity-provider groups and collectives the deposit recorded
 * came from the author's token at the time; serve cannot read them again for
 * someone else, so they are left out, never lent from the past: the record
 * keeps them for the audit trail only.
 */
function authorAccessOf(
  record: QuarantineRecord,
  sourceIp: string,
): AccessCaller {
  let principal: AccessCaller["principal"] = null;
  try {
    principal = parsePrincipal(record.principal);
  } catch {
    // An author serve cannot name is granted nothing.
  }
  return {
    principal,
    collectives: [],
    groups: [],
    sourceIp,
  };
}

/** The principal as the upload ledger keys it. */
function principalLabelOf(caller: AccessCaller): string | undefined {
  return caller.principal === null
    ? undefined
    : principalToString(caller.principal);
}

function quarantineTooLarge(): Response {
  return failure(
    413,
    "quarantine_too_large",
    `A quarantined change carries at most ${MAX_QUARANTINE_DEPOSIT_BYTES} bytes`,
  );
}

function refusalCode(refusal: CommitRefusal): "forbidden" | "commit_refused" {
  return refusal.reason === "forbidden" ||
      refusal.reason === "content-refused" ||
      refusal.reason === RUN_INITIATOR_MISMATCH_REASON
    ? "forbidden"
    : "commit_refused";
}

/** The 403 a refused commit is answered with. */
function refusalResponse(refusal: CommitRefusal): Response {
  return Response.json({
    code: refusalCode(refusal),
    reason: refusal.reason,
    opIndex: refusal.opIndex,
    message: refusal.message,
  }, { status: 403 });
}

/**
 * The lease fence and version marks of the partition `target`'s lease
 * covers, read under its lock. A run serve does not hold yet has no
 * partition: its fence starts from what this process issued. Also how a
 * new leader checks a kept lease was not superseded (swamp-club#4195).
 */
export async function leaseBaseOf(
  v3: V3Datastore,
  workflowRunRepo: Pick<YamlWorkflowRunRepository, "findGlobalById">,
  target: LockTarget,
): Promise<LeaseBase> {
  const partition = await partitionOfLock(workflowRunRepo, target);
  if (partition === undefined) return { leaseFence: undefined, names: [] };
  const marks = await v3.commitStore.leaseMarks(v3.namespace, partition);
  // A run's partition holds no data versions; only a behavior's floor
  // is sent.
  return target.kind === "model"
    ? marks
    : { leaseFence: marks.leaseFence, names: [] };
}

/** The partition `target`'s lease covers; undefined for an unknown run. */
async function partitionOfLock(
  workflowRunRepo: Pick<YamlWorkflowRunRepository, "findGlobalById">,
  target: LockTarget,
): Promise<PartitionKey | undefined> {
  if (target.kind === "model") {
    return partitionOf({
      kind: "model",
      type: ModelType.create(target.modelType),
      id: target.modelId,
    });
  }
  const found = await workflowRunRepo.findGlobalById(
    createWorkflowRunId(target.runId),
  );
  return found === null ? undefined : partitionOf({
    kind: "run",
    workflowId: found.workflowId,
    runId: target.runId,
  });
}

function namespaceOf(v3: Pick<V3Datastore, "namespace">) {
  return v3.namespace === "" ? SOLO_NAMESPACE : restoreNamespace(v3.namespace);
}

function nonNegative(value: string): number | undefined {
  if (!/^[0-9]{1,15}$/.test(value)) return undefined;
  return Number(value);
}

function pageLimit(value: string | null): number | undefined {
  if (value === null) return MAX_PAGE;
  const limit = nonNegative(value);
  return limit === undefined || limit === 0
    ? undefined
    : Math.min(limit, MAX_PAGE);
}

/** A JSON body of at most `maxBytes`; undefined when it is not JSON. */
async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBodyWithLimit(req, maxBytes);
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The HTTP reply of an error thrown while answering. */
export function datastoreErrorResponse(error: unknown): Response {
  if (error instanceof StaleSeqError) {
    return Response.json({
      code: error.code,
      seq: error.seq,
      message: error.message,
    }, { status: 409 });
  }
  if (error instanceof PreconditionConflictError) {
    return Response.json({
      code: error.code,
      key: error.key,
      seq: error.seq,
      ...(error.changedBy === undefined ? {} : { changedBy: error.changedBy }),
      ...(error.changedAt === undefined ? {} : { changedAt: error.changedAt }),
      message: `Updates were rejected: ${error.message}`,
    }, { status: 409 });
  }
  if (error instanceof TxnIdReusedError) {
    return failure(409, error.code, error.message);
  }
  if (error instanceof ChunksMissingError) {
    return Response.json({
      code: error.code,
      missing: error.missing,
      message: error.message,
    }, { status: 409 });
  }
  if (error instanceof ChunkIngestError) {
    const status = error.code === "chunk_too_large" ||
        error.code === "stream_too_large"
      ? 413
      : 400;
    return failure(status, error.code, error.message);
  }
  if (error instanceof CommitsCompactedError) {
    return Response.json({
      code: "commits_compacted",
      point: error.point,
      ...(error.compactedSeq === undefined ? {} : { seq: error.compactedSeq }),
      message: error.message,
    }, { status: 410 });
  }
  if (error instanceof CommitRejectedError) {
    return failure(409, `commit_${error.reason}`, error.message);
  }
  const { code, message } = replicationErrorForClient(error, "internal_error");
  if (code === "internal_error") {
    logger.error`Datastore API request failed: ${error}`;
    return failure(500, code, "Internal error");
  }
  return failure(
    code === "datastore_v3_writer_fenced" ? 409 : 503,
    code,
    message,
  );
}

/**
 * A commit naming a chunk it neither carries nor was vouched for: the client
 * sends the commit again with the chunk's bytes.
 */
function chunkNotProvided(hash: string | undefined): Response {
  return failure(
    403,
    "chunk_not_provided",
    `The commit names chunk ${hash}, which it neither carries nor may read`,
  );
}

const failure = httpFailure;

function leaseNotFound(): Response {
  return failure(
    404,
    "lease_not_found",
    "No such lease: it was released, or expired without a renewal",
  );
}

function uploadQuotaExceeded(): Response {
  return failure(
    429,
    "upload_quota_exceeded",
    "Too many uploaded chunks are not referenced by any commit yet",
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { code: "method_not_allowed", message: "Method not allowed" },
    { status: 405, headers: { allow } },
  );
}
