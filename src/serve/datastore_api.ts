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
 *
 * Every commit is authorised op by op on its intents
 * ({@link authorizeCommit}), its chunks are hashed as they arrive, the
 * caller is stamped as its principal, and serve's own writer commits it.
 * See "Team mode: serve's datastore API" in `design/enablers/datastores.md`.
 *
 * @module
 */

import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { Action } from "../domain/access/action.ts";
import { parsePrincipal } from "../domain/access/principal.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../domain/data/namespace.ts";
import type { BlobRef } from "../domain/datastore_v3/blob_ref.ts";
import { MAX_COMMIT_OPS } from "../domain/datastore_v3/commit.ts";
import {
  type AggregateResourceResolver,
  authorizeCommit,
  type CallerAuthority,
  partitionReadAccessOf,
  readAccessOf,
  type RequiredAccess,
} from "../domain/datastore_v3/commit_authorization.ts";
import { storageNamespaceOf } from "../domain/datastore_v3/chunk_store.ts";
import { CommitsCompactedError } from "../domain/datastore_v3/commit_store.ts";
import { type Op, opFromJSON } from "../domain/datastore_v3/op.ts";
import { CommitRejectedError } from "../domain/datastore_v3/partition.ts";
import { PartitionKey } from "../domain/datastore_v3/partition_key.ts";
import { isControlPlaneModelType } from "../domain/models/control_plane_types.ts";
import { findDefinitionByIdGlobal } from "../domain/models/model_lookup.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
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
  PreconditionConflictError,
  StaleSeqError,
  TxnIdReusedError,
} from "../infrastructure/datastore_v3/forwarded_commit.ts";
import type { UploadLedger } from "../infrastructure/datastore_v3/upload_ledger.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isAdminOnlyModelType,
  isCallerAuthorized,
  replicationErrorForClient,
} from "./handlers/shared.ts";
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

const logger = getSwampLogger(["serve", "datastore-api"]);

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
 * only once the request is authorised.
 */
export async function handleDatastoreRequest(
  req: Request,
  route: DatastoreRoute,
  sourceIp: string,
  deps: DatastoreApiDeps,
): Promise<Response> {
  const authenticated = await authenticateCaller(req, sourceIp, deps);
  if (authenticated instanceof Response) return authenticated;
  const caller = authenticated;
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
    const now = this.#now();
    const admission = this.#deps.ledger.admit(
      this.#caller.principal,
      size,
      now,
    );
    if (!admission.allowed) {
      return failure(
        429,
        "upload_quota_exceeded",
        "Too many uploaded chunks are not referenced by any commit yet",
      );
    }
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
        this.#caller.principal,
        this.#storageNamespace,
        sha256,
        size,
        now,
      );
      return Response.json({ sha256, size }, { status: 201 });
    });
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
    // it includes everything serve itself committed.
    let authorization;
    try {
      await this.#catchUp();
      authorization = await authorizeCommit(
        partition,
        ops,
        this.#resolver,
        this.#writeAuthority(),
      );
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    if (!authorization.ok) {
      await reader.cancel();
      return Response.json({
        code: authorization.reason === "forbidden"
          ? "forbidden"
          : "commit_refused",
        reason: authorization.reason,
        opIndex: authorization.opIndex,
        message: authorization.message,
      }, { status: 403 });
    }
    // The content arrives after the envelope. Each chunk is admitted
    // against the caller's upload quota, hashed as it is read, staged and
    // recorded before the next is read, so the request holds one chunk at a
    // time and the quota counts what it has sent so far. A mismatch fails
    // the request before anything is committed.
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
    const referenced = referencedChunks(ops);
    // Authorised again under the datastore's forwarded-commit lock, once the
    // content is in: key ownership cannot change between the check and the
    // append, and a grant revoked during the upload applies.
    const landed = await withForwardedLock(this.#v3, async () => {
      await this.#catchUp();
      // Looked up afresh: a definition retagged during the upload is judged
      // as it is now.
      const resolver = memoized(serveResolver(this.#deps.ctx, this.#v3));
      const recheck = await authorizeCommit(
        partition,
        ops,
        resolver,
        this.#writeAuthority(),
      );
      if (!recheck.ok) return recheck;
      // Proof of possession under the lock too, so a read grant revoked
      // during the upload no longer vouches for a chunk.
      for (const hash of referenced) {
        if (carried.has(hash) || (await this.#mayReference(hash))) continue;
        return { notProvided: hash };
      }
      const result = await commitForwarded(this.#v3, {
        partition,
        txnId: envelope.txnId,
        expectedSeq: envelope.expectedSeq,
        ...(envelope.fence === undefined ? {} : { fence: envelope.fence }),
        principal: this.#caller.principal,
        ops,
      }, req.signal);
      return { result };
    });
    if ("notProvided" in landed) {
      return failure(
        403,
        "chunk_not_provided",
        `The commit names chunk ${landed.notProvided}, which it neither carries nor may read`,
      );
    }
    if ("ok" in landed) {
      return Response.json({
        code: landed.reason === "forbidden" ? "forbidden" : "commit_refused",
        reason: landed.reason,
        opIndex: landed.opIndex,
        message: landed.message,
      }, { status: 403 });
    }
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
    return Response.json({
      head: head.seq,
      commits: page.map((change) => change.commit.toJSON()),
    });
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
          kept.push({ cursor: change.cursor, commit: change.commit.toJSON() });
          if (kept.length >= limit) break;
        }
      }
    }
    // The next cursor moves past filtered rows too, so a caller who may
    // read nothing still makes progress.
    return Response.json({ changes: kept, cursor: next, more });
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
  async #mayReference(sha256: string): Promise<boolean> {
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
      if (
        await this.#mayRead(
          await partitionReadAccessOf(partition, this.#resolver),
        )
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
    const required: RequiredAccess[] = [];
    let intents = 0;
    for (const op of ops) {
      if (op.kind === "put" || op.kind === "tombstone") intents++;
      const access = await readAccessOf(op, this.#resolver);
      if (access !== undefined) required.push(access);
    }
    // A commit with no intent-bearing op (serve's own lease commits) still
    // names its partition: it is read as the partition is.
    if (intents === 0) {
      for (
        const access of await partitionReadAccessOf(partition, this.#resolver)
      ) {
        required.push(access);
      }
    }
    return this.#mayRead(required);
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
      allows: (action, resource) =>
        isCallerAuthorized(
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
   * recording each in the upload ledger, then makes them durable together.
   * Resolves with their hashes, or a 429 once the caller's quota is spent.
   */
  async #ingestCarried(
    reader: FramedReader,
    declared: readonly { sha256: string; size: number }[],
    signal: AbortSignal,
  ): Promise<Set<string> | Response> {
    const staged = new Map<string, number>();
    let pending = 0;
    const batch = this.#v3.chunkStore.beginBatch(namespaceOf(this.#v3));
    try {
      for (const chunk of declared) {
        // What this request staged counts too: it is recorded only once
        // the batch is durable.
        pending += chunk.size;
        if (
          !this.#deps.ledger.admit(
            this.#caller.principal,
            pending,
            this.#now(),
          ).allowed
        ) {
          return failure(
            429,
            "upload_quota_exceeded",
            "Too many uploaded chunks are not referenced by any commit yet",
          );
        }
        const verified = await ingestChunk(
          reader,
          chunk,
          { maxChunkBytes: this.#maxChunkBytes() },
          signal,
        );
        await batch.put(verified.sha256, verified.bytes, signal);
        staged.set(verified.sha256, verified.size);
      }
      await reader.assertEnd(signal);
      if (staged.size === 0) return new Set();
      await batch.commit(signal);
      // Recorded once durable: a batch discarded on a later failure leaves
      // nothing counting toward the quota.
      for (const [sha256, size] of staged) {
        this.#deps.ledger.record(
          this.#caller.principal,
          this.#storageNamespace,
          sha256,
          size,
          this.#now(),
        );
      }
      return new Set(staged.keys());
    } finally {
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

/**
 * `resolver` with its aggregate lookups remembered for one request, so a
 * changes page costs one lookup per aggregate, not per op. Key owners and
 * restricted types are asked afresh.
 */
function memoized(
  resolver: AggregateResourceResolver,
): AggregateResourceResolver {
  const models = new Map<
    string,
    ReturnType<AggregateResourceResolver["model"]>
  >();
  const workflows = new Map<
    string,
    ReturnType<AggregateResourceResolver["workflow"]>
  >();
  const tags = new Map<
    string,
    ReturnType<AggregateResourceResolver["definitionTags"]>
  >();
  const remember = <T>(map: Map<string, T>, key: string, load: () => T): T => {
    let value = map.get(key);
    if (value === undefined) {
      value = load();
      map.set(key, value);
    }
    return value;
  };
  return {
    model: (ref) =>
      remember(models, `${ref.type}\u0000${ref.id}`, () => resolver.model(ref)),
    workflow: (id) => remember(workflows, id, () => resolver.workflow(id)),
    definitionTags: (kind, name, type) =>
      remember(
        tags,
        `${kind}\u0000${name}\u0000${type?.normalized ?? ""}`,
        () => resolver.definitionTags(kind, name, type),
      ),
    keyOwner: (key) => resolver.keyOwner(key),
    isRestrictedType: (type) => resolver.isRestrictedType(type),
  };
}

/** The resolver serve's datastore API authorises against. */
function serveResolver(
  ctx: ConnectionContext,
  v3: V3Datastore,
): AggregateResourceResolver {
  const repos = ctx.repoContext;
  return {
    async model(ref) {
      const lookup = await findDefinitionByIdGlobal(
        repos.definitionRepo,
        ref.id,
      );
      // A definition of another type is not this behavior: the intent's type
      // is what the commit writes.
      return lookup !== null && lookup.type.normalized === ref.type
        ? lookup
        : undefined;
    },
    async definitionTags(kind, name, type) {
      switch (kind) {
        case "model": {
          if (type === undefined) return undefined;
          const definition = await repos.definitionRepo.findByName(type, name);
          return definition?.tags;
        }
        case "workflow":
          return (await repos.workflowRepo.findByName(name))?.tags;
        case "vault":
          return undefined;
      }
    },
    async workflow(workflowId) {
      const workflow = await findWorkflowById(repos.workflowRepo, workflowId);
      return workflow === null
        ? undefined
        : { name: workflow.name, tags: workflow.tags };
    },
    keyOwner(key) {
      return v3.readModel.fileOwner(v3.namespace, key);
    },
    isRestrictedType(type: ModelType) {
      return isAdminOnlyModelType(
        undefined,
        type.normalized,
        ctx.authConfig.restrictedModelTypes,
      );
    },
  };
}

interface CommitEnvelope {
  readonly expectedSeq: number;
  readonly txnId: string;
  readonly fence?: number;
  readonly ops: readonly unknown[];
  readonly chunks: readonly { sha256: string; size: number }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = new Set([
  "expectedSeq",
  "txnId",
  "fence",
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
  const { expectedSeq, txnId, fence, ops, chunks } = json;
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
