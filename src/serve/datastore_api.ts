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
 * | `GET partitions/{p}/commits?after=` | a partition's commits after a seq |
 * | `GET changes?cursor=` | every commit since a cursor the caller may read |
 * | `GET base?after=` | the compacted base, a page at a time, filtered to what the caller may read |
 * | `POST locks` | take serve's model or workflow-run lock for the caller: a lease |
 * | `PUT locks/{leaseId}` | renew a lease |
 * | `DELETE locks/{leaseId}` | release a lease |
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
import { parsePrincipal } from "../domain/access/principal.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../domain/data/namespace.ts";
import type { BlobRef } from "../domain/datastore_v3/blob_ref.ts";
import { type Commit, MAX_COMMIT_OPS } from "../domain/datastore_v3/commit.ts";
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
  PartitionKey,
  partitionOf,
} from "../domain/datastore_v3/partition_key.ts";
import { ReadModelIncompleteError } from "../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import { isControlPlaneModelType } from "../domain/models/control_plane_types.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { createWorkflowRunId } from "../domain/workflows/workflow_id.ts";
import {
  ChunkIngestError,
  chunkReadResponse,
  FramedReader,
  ingestChunk,
  isSha256Hex,
  parseRange,
} from "../infrastructure/datastore_v3/chunk_ingest.ts";
import {
  ChunksMissingError,
  commitForwarded,
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
  LEASE_OPS_FEATURE,
  SERVE_DATASTORE_ACCESS_HEADER,
  SERVE_DATASTORE_FEATURES_HEADER,
  SERVE_DATASTORE_LOG_HEADER,
} from "../infrastructure/datastore_v3/serve_datastore_client.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isCallerAuthorized,
  isCallerAuthorizedForAll,
  replicationErrorForClient,
} from "./handlers/shared.ts";
import {
  commitReadAccessOf,
  memoized,
  serveResolver,
} from "./commit_read_filter.ts";
import {
  checkIpBurst,
  checkPrincipalRate,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
} from "./rate_limiter.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";
import type { DatastoreRoute } from "./datastore_routes.ts";
import { ForwardedContentAuthority } from "./forwarded_content_authorization.ts";
import {
  type DatastoreLockLeases,
  DEFAULT_LOCK_TTL_MS,
  type LeaseBase,
  type LeaseView,
  type LockHolder,
  type LockTarget,
  lockTargetOfPartition,
  parseLockKey,
} from "./datastore_locks.ts";
import { ServeNotLeaderError } from "../domain/datastore_v3/serve_leader.ts";
import { notLeaderResponse } from "./leader_link.ts";

const logger = getSwampLogger(["serve", "datastore-api"]);

/** The most leases one `GET locks` lists (swamp-club#4121). */
export const MAX_LISTED_LEASES = 512;

/** The largest commit envelope, before it is parsed. */
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
/** The most chunks one commit request carries. */
export const MAX_CHUNKS_PER_COMMIT = 1024;
/** The largest commit request body: envelope and chunks. */
export const MAX_COMMIT_BODY_BYTES = 1024 * 1024 * 1024;
/** The most hashes one `chunks/has` asks about. */
export const MAX_HAS_HASHES = 1024;
/** The largest page of commits or changes. */
export const MAX_PAGE = 1000;
/** The most feed rows one changes request scans, kept or filtered. */
export const MAX_CHANGES_SCAN = 10_000;
/** The most compacted base entries one base request scans, kept or filtered. */
export const MAX_BASE_SCAN = 10_000;
/** The most partitions a chunk read checks the caller against. */
const MAX_REFERENCING_PARTITIONS = 64;
/** The most chunk requests one principal has in flight. */
export const MAX_CONCURRENT_CHUNK_REQUESTS = 8;

/** The principal an unauthenticated server (`--auth-mode none`) stamps. */
export const ANONYMOUS_PRINCIPAL = "@anonymous";

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
  readonly now?: () => number;
}

/** An authenticated caller of the API. */
interface ApiCaller {
  readonly access: AccessCaller;
  /** The principal stamped on its commits. */
  readonly principal: string;
}

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
  const authenticated = await authenticateCaller(req, sourceIp, deps);
  if (authenticated instanceof Response) return authenticated;
  // A follower in team mode passes a write on to the leader with the
  // caller's own credentials (swamp-club#4120), and answers reads only
  // while its copy is fresh (swamp-club#4096); after authentication, so
  // only a caller reaches the leader through it or learns which node leads.
  const notLeader = followerDatastoreRefusal(req, route, sourceIp, deps.ctx);
  if (notLeader !== undefined) return await notLeader;
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
  return withHeaders(response, headers);
}

/**
 * Whether the client's copy understands lease ops (swamp-club#4121): it
 * names {@link LEASE_OPS_FEATURE} in {@link SERVE_DATASTORE_FEATURES_HEADER}.
 */
function readsLeaseOps(req: Request): boolean {
  return (req.headers.get(SERVE_DATASTORE_FEATURES_HEADER) ?? "")
    .split(",")
    .some((feature) => feature.trim() === LEASE_OPS_FEATURE);
}

/**
 * `commit` as a reader is sent it: without its lease ops for a client that
 * does not understand them (swamp-club#4121). A swamp from before them
 * judges a lease op's fence against the writer fence; without it, the
 * commit is exactly what that swamp's own rules accept. Serve stamps a
 * lease op only beside a client's ops, so no commit is left empty.
 */
function commitJSONFor(commit: Commit, leaseOps: boolean): unknown {
  const json = commit.toJSON() as { ops: readonly { kind?: unknown }[] };
  return leaseOps
    ? json
    : { ...json, ops: json.ops.filter((op) => op.kind !== "lease") };
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
  const { principal, collectives, groups } = caller.access;
  if (!loader || !principal) return NO_READ_ACCESS;
  try {
    return loader.decisionService.readAccessFingerprint(
      { principal, collectives, groups },
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
      case "base":
        return req.method === "GET"
          ? await api.compactedBase(req)
          : methodNotAllowed("GET");
      case "locks":
        return req.method === "POST"
          ? await api.acquireLock(req)
          : req.method === "GET"
          ? await api.listLocks(req)
          : methodNotAllowed("GET, POST");
      case "lease":
        if (req.method === "PUT") {
          return await api.renewLock(req, route.leaseId);
        }
        if (req.method === "DELETE") {
          return await api.releaseLock(route.leaseId);
        }
        return methodNotAllowed("DELETE, PUT");
    }
  } catch (error) {
    return datastoreErrorResponse(error);
  }
}

async function authenticateCaller(
  req: Request,
  sourceIp: string,
  deps: DatastoreApiDeps,
): Promise<ApiCaller | Response> {
  const { ctx } = deps;
  if (ctx.authConfig.mode === "none") {
    return {
      access: { principal: null, collectives: [], groups: [], sourceIp },
      principal: ANONYMOUS_PRINCIPAL,
    };
  }
  const token = bearerToken(req);
  if (token === null) {
    // Only callers that fail to authenticate count toward the IP's burst:
    // an authenticated team's traffic is limited per principal instead.
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return failure(401, "unauthorized", "Unauthorized: token required");
  }
  const key = rateLimitKey(token, sourceIp);
  const rateCheck = checkRateLimit(key);
  if (!rateCheck.allowed) return tooManyRequests(rateCheck.retryAfterSeconds);
  const auth = await deps.authenticate(token, sourceIp);
  if (!auth.ok) {
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    return failure(401, "unauthorized", `Unauthorized: ${auth.reason}`);
  }
  clearRateLimit(key);
  const rate = checkPrincipalRate(auth.principalId, deps.now?.());
  if (!rate.allowed) return tooManyRequests(rate.retryAfterSeconds);
  return {
    access: {
      principal: parsePrincipal(auth.principalId),
      collectives: auth.collectives,
      groups: auth.groups,
      sourceIp,
      loginIdentity: auth.oauthIdentity,
    },
    principal: auth.principalId,
  };
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
    // else reads as missing, so the answer reveals no other content.
    const referable: string[] = [];
    for (const hash of new Set(hashes as string[])) {
      if (await this.#mayReference(hash)) referable.push(hash);
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
    // exist, so the reply is no oracle for others' content.
    if (!(await this.#mayReference(sha256))) {
      return failure(404, "not_found", "No such chunk");
    }
    return await this.#withChunkSlot(async () => {
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

  /** `POST partitions/{p}/commits`. */
  async commit(req: Request, partitionSegment: string): Promise<Response> {
    const partition = parsePartition(partitionSegment);
    if (partition === undefined) {
      return failure(400, "invalid_request", "Not a partition key");
    }
    const reader = new FramedReader(req.body ?? ReadableStream.from([]), {
      maxBytes: MAX_COMMIT_BODY_BYTES,
    });
    const envelopeLength = await reader.readUint32BE(req.signal);
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
            await reader.readExactly(envelopeLength, req.signal),
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
    // reserved in the upload ledger before it is read, then it is hashed
    // and staged, so the request holds one chunk at a time and the quota
    // counts what it has sent so far. A mismatch fails the request before
    // anything is committed.
    let provided: Set<string> | Response;
    try {
      provided = await this.#withChunkSlot(() =>
        this.#ingestCarried(reader, envelope.chunks, req.signal)
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
      content = new ForwardedContentAuthority({
        ctx: this.#deps.ctx,
        v3: this.#v3,
        partition,
        caller: this.#caller.access,
        requestId: this.#requestId,
        resolver,
        possesses: async (hash) =>
          carried.has(hash) || (await this.#mayReference(hash, resolver)),
        signal: req.signal,
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
    const landed = await withForwardedLock(this.#v3, async () => {
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
      // during the upload no longer vouches for a chunk.
      for (const hash of referenced) {
        if (carried.has(hash) || (await this.#mayReference(hash, resolver))) {
          continue;
        }
        return { notProvided: hash };
      }
      // Judged under the forwarded lock, as leases change hands between
      // commits: the live fenced lease covering the partition decides.
      const lease = this.#leaseOpFor(partition, envelope.lease);
      if (lease === "lost") return { leaseLost: true as const };
      const result = await commitForwarded(
        this.#v3,
        lease === undefined ? request : { ...request, lease },
        req.signal,
      );
      return { result };
    });
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
    if ("notProvided" in landed) {
      return failure(
        403,
        "chunk_not_provided",
        `The commit names chunk ${landed.notProvided}, which it neither carries nor may read`,
      );
    }
    if ("ok" in landed) return refusalResponse(landed);
    const { result } = landed;
    this.#deps.ledger.release(this.#storageNamespace, referenced);
    // Outside the lock: the next forwarded commit catches up before it
    // authorises anyway, so holding the lock for this one gains nothing.
    const warning = await this.#afterCommit(partition);
    if (this.#deps.ctx.confirmReplicated !== undefined) {
      try {
        await this.#deps.ctx.confirmReplicated();
      } catch (error) {
        // Landed, and not yet replicated: a retry under the same txnId
        // finds it.
        const { code, message } = replicationErrorForClient(
          error,
          "internal_error",
        );
        return Response.json({ code, message, seq: result.seq }, {
          status: 503,
        });
      }
    }
    return Response.json({
      seq: result.seq,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(warning === undefined ? {} : { warning }),
    });
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
    if (
      !(await this.#mayRead(
        await partitionReadAccessOf(partition, this.#resolver),
      ))
    ) {
      return failure(404, "not_found", "No such partition");
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
        commits.push(commitJSONFor(change.commit, readsLeaseOps(req)));
      }
    }
    return Response.json({ head: head.seq, commits });
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
    const kept: { cursor: number; commit: unknown }[] = [];
    let next = cursor;
    let scanned = 0;
    let more = true;
    while (kept.length < limit && scanned < MAX_CHANGES_SCAN) {
      const page = await this.#v3.commitStore.changesSince(
        next,
        Math.min(MAX_PAGE, MAX_CHANGES_SCAN - scanned),
      );
      if (page.length === 0) {
        more = false;
        break;
      }
      for (const change of page) {
        scanned++;
        next = change.cursor;
        if (
          change.commit.namespace === this.#namespace &&
          (await this.#mayReadCommit(
            change.commit.partition,
            change.commit.ops,
          ))
        ) {
          kept.push({
            cursor: change.cursor,
            commit: commitJSONFor(change.commit, readsLeaseOps(req)),
          });
          if (kept.length >= limit) break;
        }
      }
    }
    // The next cursor moves past filtered rows too, so a caller who may
    // read nothing still makes progress.
    return Response.json({ changes: kept, cursor: next, more });
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
    const refused = await this.#authorizeLock(target);
    if (refused !== undefined) return refused;
    const outcome = await this.#deps.locks.acquire({
      principal: this.#caller.principal,
      target,
      ttlMs,
      waitMs,
      signal: req.signal,
      ...(fenced ? { fenced: () => this.#leaseBase(target) } : {}),
      ...(holdMs !== undefined ? { holdMs: holdMs as number } : {}),
    });
    switch (outcome.kind) {
      case "acquired":
        return Response.json(outcome.lease, { status: 201 });
      case "too-many":
        return failure(
          429,
          "too_many_leases",
          "This caller holds too many locks: release some before taking another",
        );
      case "held":
        // Who holds it is said only as far as the caller may know: itself,
        // another caller, or serve's own work. Never another's identity.
        return Response.json({
          code: "lock_held",
          heldBy: outcome.heldBy,
          message: outcome.heldBy === "caller"
            ? `${fields.lockKey} is held by another of this caller's commands`
            : outcome.heldBy === "other"
            ? `${fields.lockKey} is held by another caller`
            : `${fields.lockKey} is held by serve's own work`,
        }, { status: 409, headers: { "Retry-After": "1" } });
    }
  }

  /**
   * `GET locks?prefix=`: the leases serve holds on locks the caller could
   * take itself (swamp-club#4121), each as its key, who holds it (`caller`
   * or `other`, never who) and when it ends unless renewed. Each lock is
   * decided without a refusal audit, since a listing refuses nothing. At
   * most {@link MAX_LISTED_LEASES}, with `truncated` set past it.
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
    if (held === undefined) return leaseNotFound();
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
    const renewed: LeaseView | undefined = this.#deps.locks.renew(
      principal,
      leaseId,
      ttlMs,
      holdMs as number | undefined,
    );
    return renewed === undefined ? leaseNotFound() : Response.json(renewed);
  }

  /** `DELETE locks/{leaseId}`: releases the caller's lease. */
  async releaseLock(leaseId: string): Promise<Response> {
    return await this.#deps.locks.release(this.#caller.principal, leaseId)
      ? Response.json({ released: true })
      : leaseNotFound();
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
    const partition = await this.#partitionOfLock(target);
    if (partition === undefined) return { leaseFence: undefined, names: [] };
    const marks = await this.#v3.commitStore.leaseMarks(
      this.#namespace,
      partition,
    );
    // A run's partition holds no data versions; only a behavior's floor
    // is sent.
    return target.kind === "model"
      ? marks
      : { leaseFence: marks.leaseFence, names: [] };
  }

  /** The partition `target`'s lease covers; undefined for an unknown run. */
  async #partitionOfLock(
    target: LockTarget,
  ): Promise<PartitionKey | undefined> {
    if (target.kind === "model") {
      return partitionOf({
        kind: "model",
        type: ModelType.create(target.modelType),
        id: target.modelId,
      });
    }
    const found = await this.#deps.ctx.repoContext.workflowRunRepo
      .findGlobalById(createWorkflowRunId(target.runId));
    return found === null ? undefined : partitionOf({
      kind: "run",
      workflowId: found.workflowId,
      runId: target.runId,
    });
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

  /**
   * Catches serve's checkout up with what landed and reloads what it holds
   * in memory: the query catalog, and the policy when a control-plane
   * record changed, so a revoked grant or token is refused on the next
   * request. A failure is a warning: the commit has landed.
   */
  async #afterCommit(partition: PartitionKey): Promise<string | undefined> {
    const { ctx } = this.#deps;
    try {
      await this.#catchUp();
      ctx.repoContext.catalogStore.invalidate();
      const identity = partition.identity;
      if (
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
   */
  async #mayReference(
    sha256: string,
    resolver: AggregateResourceResolver = this.#resolver,
  ): Promise<boolean> {
    if (
      this.#deps.ledger.holds(
        this.#caller.principal,
        this.#storageNamespace,
        sha256,
        this.#now(),
      )
    ) {
      return true;
    }
    const partitions = await this.#v3.commitStore.partitionsReferencing(
      this.#namespace,
      sha256,
      MAX_REFERENCING_PARTITIONS,
    );
    for (const partition of partitions) {
      const identity = partition.identity;
      if (
        identity.kind === "config" && identity.definitionKind === "model"
          ? await this.#mayReadDefinitionChunk(
            partition,
            identity.name,
            sha256,
            resolver,
          )
          : this.#mayRead(await partitionReadAccessOf(partition, resolver))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a behavior definition's config partition vouches for `sha256`:
   * a record in it now names the chunk, and the caller may read that record
   * as the changes feed decides the op that wrote it. Same-named
   * definitions of several types share the partition, a control-plane one
   * among them, so the partition as a whole decides nothing (swamp-club#3938).
   * A read model not yet complete vouches for nothing.
   */
  async #mayReadDefinitionChunk(
    partition: PartitionKey,
    name: string,
    sha256: string,
    resolver: AggregateResourceResolver,
  ): Promise<boolean> {
    let records;
    try {
      records = await this.#v3.readModel.liveRecords(
        this.#namespace,
        partition,
      );
    } catch (error) {
      if (error instanceof ReadModelIncompleteError) return false;
      throw error;
    }
    for (const record of records) {
      if (
        record.content.kind === "blob" &&
        record.content.blob.chunkHashes().includes(sha256) &&
        this.#mayRead([
          await definitionRecordReadAccessOf(name, record.key, resolver),
        ])
      ) {
        return true;
      }
    }
    return false;
  }

  async #mayReadCommit(
    partition: PartitionKey,
    ops: readonly Op[],
  ): Promise<boolean> {
    return this.#mayRead(
      await commitReadAccessOf(partition, ops, this.#resolver),
    );
  }

  /** Decides reads without auditing each one: they filter, not refuse. */
  #mayRead(required: readonly RequiredAccess[]): boolean {
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
   * Reads, verifies and stages a commit's carried chunks one at a time,
   * each reserved in the upload ledger before it is read, then makes them
   * durable together and records them. Resolves with their hashes, or a
   * 429 once the caller's quota or entry cap is spent.
   */
  async #ingestCarried(
    reader: FramedReader,
    declared: readonly { sha256: string; size: number }[],
    signal: AbortSignal,
  ): Promise<Set<string> | Response> {
    const reservations: UploadReservation[] = [];
    const staged = new Map<string, UploadReservation>();
    const batch = this.#v3.chunkStore.beginBatch(namespaceOf(this.#v3));
    try {
      for (const chunk of declared) {
        // What this request reserved counts too, so requests in flight
        // together cannot pass the quota or the entry cap.
        const admission = this.#deps.ledger.reserve(
          this.#caller.principal,
          chunk.size,
          this.#now(),
        );
        if (!admission.allowed) return uploadQuotaExceeded();
        reservations.push(admission.reservation);
        const verified = await ingestChunk(
          reader,
          chunk,
          { maxChunkBytes: this.#maxChunkBytes() },
          signal,
        );
        await batch.put(verified.sha256, verified.bytes, signal);
        if (!staged.has(verified.sha256)) {
          staged.set(verified.sha256, admission.reservation);
        }
      }
      await reader.assertEnd(signal);
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
      for (const chunk of chunks) {
        await batch.put(chunk.sha256, chunk.bytes, signal);
      }
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

/** The 403 a refused commit is answered with. */
function refusalResponse(refusal: CommitRefusal): Response {
  return Response.json({
    code: refusal.reason === "forbidden" || refusal.reason === "content-refused"
      ? "forbidden"
      : "commit_refused",
    reason: refusal.reason,
    opIndex: refusal.opIndex,
    message: refusal.message,
  }, { status: 403 });
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

const BEARER_PREFIX_LEN = "Bearer ".length;

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (
    header === null ||
    header.slice(0, BEARER_PREFIX_LEN).toLowerCase() !== "bearer "
  ) return null;
  const token = header.slice(BEARER_PREFIX_LEN);
  return token.length > 0 ? token : null;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

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

function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { code: "rate_limited", message: "Too Many Requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { code: "method_not_allowed", message: "Method not allowed" },
    { status: 405, headers: { allow } },
  );
}
