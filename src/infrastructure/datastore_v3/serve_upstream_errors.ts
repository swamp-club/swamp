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
 * The errors {@link ServeDatastoreClient} throws for serve's datastore API
 * replies (swamp-club#3985), each mapped from serve's status and `code` so
 * a caller handles a refusal from serve as it handles the same refusal from
 * a local commit: a precondition that failed is a `CommitRejectedError`
 * with reason `expect-failed`, a partition's refusal a
 * `CommitRejectedError` with its reason, and compaction a
 * `CommitsCompactedError`. Serve's message is kept verbatim; the codes
 * serve shares with the CLI (a fenced writer, an unreachable storage) are
 * kept, so the exit code a command ends with is the one it would end with
 * locally.
 *
 * @module
 */

import { serverLoginHint } from "../../domain/auth/server_login_hint.ts";
import {
  COMMIT_MAY_LAND_CODE,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import {
  CommitRejectedError,
  type CommitRejection,
} from "../../domain/datastore_v3/partition.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  V3_SERVE_UNREACHABLE_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  parseServeLeader,
  SERVE_NOT_LEADER_CODE,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";

export { V3_SERVE_UNREACHABLE_CODE };

/** Whether a request that failed may have reached serve. */
export type ServeRequestSent = "never" | "maybe";

/**
 * Serve could not be reached, or stopped answering, so the request failed
 * without a reply. With `sent` `"never"` the connection was never made
 * (refused, a failed lookup, a failed TLS handshake), so serve changed
 * nothing; with `"maybe"` the request may have reached serve. `cause` is
 * the transport's error, so `isNetworkFailure` recognises this error.
 * Nothing goes around serve to the datastore's storage: a datastore
 * reached through serve is never reached any other way.
 */
export class ServeUnreachableError extends UserError {
  declare readonly code: typeof V3_SERVE_UNREACHABLE_CODE;

  constructor(
    readonly serveUrl: string,
    readonly sent: ServeRequestSent,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const outcome = sent === "never"
      ? `Swamp could not reach serve at ${serveUrl} (${reason}), so the ` +
        `datastore was not changed.`
      : `Swamp lost its connection to serve at ${serveUrl} (${reason}) ` +
        `after the request may have reached it, so serve may or may not ` +
        `have made the change. The change is kept: the next command that ` +
        `writes in this checkout sends it again, and serve records it once ` +
        `whether or not it already landed.`;
    super(
      `${outcome} This datastore is reached only through serve, so swamp ` +
        `never goes around serve to the datastore's storage. Run the ` +
        `command again once serve is reachable.`,
      V3_SERVE_UNREACHABLE_CODE,
    );
    this.name = "ServeUnreachableError";
    this.cause = cause;
  }
}

/**
 * A read in a checkout that has never read its datastore from serve, while
 * serve cannot be reached (swamp-club#3985): its copy holds nothing yet,
 * so an empty answer would look like an empty datastore. Exits 75 as an
 * unreachable serve does.
 */
export class ServeNeverReadError extends UserError {
  declare readonly code: typeof V3_SERVE_UNREACHABLE_CODE;

  constructor(readonly serveUrl: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Swamp could not reach serve at ${serveUrl} (${reason}), and this ` +
        `checkout has not read this datastore from serve yet, so there is ` +
        `nothing local to show. Run the command again once serve is ` +
        `reachable.`,
      V3_SERVE_UNREACHABLE_CODE,
    );
    this.name = "ServeNeverReadError";
    this.cause = cause;
  }
}

/** Error code for a serve that is not serving the log a copy follows. */
export const SERVE_UPSTREAM_DIVERGED_CODE = "serve_upstream_diverged";

/** A commit of a copy serve was checked against: see {@link ServeUpstreamDivergedError}. */
export interface ServeDivergedCommit {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string | undefined;
}

/**
 * What serve answered that the copy does not follow: another commit log's
 * id; or, for a commit the copy holds or followed, a head for its
 * partition below the commit's seq, or another commit at that seq.
 */
export type ServeDivergence =
  | {
    readonly kind: "other-log";
    readonly copyLogId: string;
    readonly serveLogId: string;
  }
  | { readonly kind: "behind"; readonly serveHead: number }
  | { readonly kind: "other-commit"; readonly serveTxnId: string };

/**
 * Serve at a checkout's address is not serving the commit log the
 * checkout's copy follows (swamp-club#4049): the address now reaches
 * another serve or datastore (another log id), or one restored to an
 * earlier point (a commit the copy holds, missing). `commit` is that
 * commit, undefined for another log. The copy is never re-synced on its
 * own, since a copy holding commits serve lost may be what a restore
 * needs; a fresh copy starts once this one is moved aside.
 */
export class ServeUpstreamDivergedError extends UserError {
  declare readonly code: typeof SERVE_UPSTREAM_DIVERGED_CODE;

  constructor(
    readonly serveUrl: string,
    readonly copyDir: string,
    readonly commit: ServeDivergedCommit | undefined,
    readonly divergence: ServeDivergence,
  ) {
    super(
      `Serve at ${serveUrl} is not serving the datastore this checkout's ` +
        `copy at ${copyDir} follows: ${divergenceOf(commit, divergence)}. ` +
        `The address may now reach another serve or datastore, or one ` +
        `restored from an earlier backup. Swamp does not re-sync the copy ` +
        `on its own, since it may hold commits serve lost. To start a ` +
        `fresh copy from this serve, move ${copyDir} aside; commits not ` +
        `yet sent to serve stay in the moved copy's outbox.`,
      SERVE_UPSTREAM_DIVERGED_CODE,
    );
    this.name = "ServeUpstreamDivergedError";
    markErrorPaths(this, [copyDir]);
  }
}

function divergenceOf(
  commit: ServeDivergedCommit | undefined,
  divergence: ServeDivergence,
): string {
  if (divergence.kind === "other-log" || commit === undefined) {
    return divergence.kind === "other-log"
      ? `the copy follows commit log ${divergence.copyLogId}, and serve ` +
        `answers with log ${divergence.serveLogId}`
      : "serve does not hold the commits the copy follows";
  }
  const at =
    `the copy has commit ${commit.seq} of partition ${commit.partition}`;
  return divergence.kind === "behind"
    ? `${at}, and serve's head for that partition is ${divergence.serveHead}`
    : `${at}, and serve holds another commit at that seq`;
}

/** Error code for a serve too old to say which commit log it serves. */
export const SERVE_UPSTREAM_UPGRADE_REQUIRED_CODE =
  "serve_upstream_upgrade_required";

/**
 * Serve answered without the id of the commit log it serves
 * (swamp-club#4049): a swamp too old to send it. The checkout cannot tell
 * whether serve still serves the log its copy follows, so the reply is not
 * used.
 */
export class ServeUpstreamUpgradeRequiredError extends UserError {
  declare readonly code: typeof SERVE_UPSTREAM_UPGRADE_REQUIRED_CODE;

  constructor(readonly serveUrl: string) {
    super(
      `Serve at ${serveUrl} did not say which commit log it serves, so ` +
        `this checkout cannot tell whether serve still holds the datastore ` +
        `its copy follows, and did not use the reply. Upgrade swamp on ` +
        `serve to a version that reports it (this one does), then run the ` +
        `command again.`,
      SERVE_UPSTREAM_UPGRADE_REQUIRED_CODE,
    );
    this.name = "ServeUpstreamUpgradeRequiredError";
  }
}

/**
 * A reply serve's datastore API refused a request with. `code` is serve's
 * own, `message` serve's verbatim.
 */
export class ServeUpstreamError extends UserError {
  declare readonly code: string;

  constructor(readonly status: number, code: string, message: string) {
    super(message, code);
    this.name = "ServeUpstreamError";
  }
}

/** 401: the token is missing, expired or revoked. */
export class ServeAuthFailedError extends ServeUpstreamError {
  constructor(readonly serveUrl: string, readonly serveMessage: string) {
    super(401, "unauthorized", serverLoginHint(serveUrl));
    this.name = "ServeAuthFailedError";
  }
}

/** 409 `stale_seq`: the partition's head moved; catch up and build again. */
export class ServeStaleSeqError extends ServeUpstreamError {
  declare readonly code: "stale_seq";

  constructor(
    /** The partition's head at serve. */
    readonly seq: number,
    message: string,
  ) {
    super(409, "stale_seq", message);
    this.name = "ServeStaleSeqError";
  }
}

/**
 * 409 `precondition_failed`: a record the commit expected changed since the
 * caller read it. A `CommitRejectedError` with reason `expect-failed`, as
 * a local commit refused for the same reason is, carrying no `code` as
 * that one carries none, and serve's message verbatim.
 */
export class ServePreconditionFailedError extends CommitRejectedError {
  /** HTTP status of the reply. */
  readonly status = 409;

  constructor(
    /** The record key as serve named it. */
    readonly recordKey: string,
    /** The partition's head at serve. */
    readonly seq: number,
    readonly changedBy: string | undefined,
    readonly changedAt: string | undefined,
    message: string,
  ) {
    super("expect-failed", message, recordKeyOrUndefined(recordKey));
    this.name = "ServePreconditionFailedError";
  }
}

/**
 * 409 `commit_<reason>`: the partition refused the commit. A
 * `CommitRejectedError` with that reason, as a local refusal is, keeping
 * serve's code and message.
 */
export class ServeCommitRejectedError extends CommitRejectedError {
  readonly status = 409;

  constructor(reason: CommitRejection, readonly code: string, message: string) {
    super(reason, message);
    this.name = "ServeCommitRejectedError";
  }
}

/** 409 `chunk_missing`: chunks the commit names that serve does not hold. */
export class ServeChunksMissingError extends ServeUpstreamError {
  declare readonly code: "chunk_missing";

  constructor(readonly missing: readonly string[], message: string) {
    super(409, "chunk_missing", message);
    this.name = "ServeChunksMissingError";
  }
}

/**
 * 403 `forbidden` or `commit_refused`: the commit was refused op by op on
 * the caller's access or content. `opIndex` is the op refused.
 */
export class ServeCommitRefusedError extends ServeUpstreamError {
  constructor(
    code: string,
    /** The refusal's reason, as serve names it. */
    readonly reason: string | undefined,
    readonly opIndex: number | undefined,
    message: string,
  ) {
    super(403, code, message);
    this.name = "ServeCommitRefusedError";
  }
}

/**
 * 410 `commits_compacted`: the commits asked for were compacted. A
 * `CommitsCompactedError` at serve's compaction point, with serve's
 * message verbatim.
 */
export class ServeCommitsCompactedError extends CommitsCompactedError {
  readonly status = 410;
  readonly code = "commits_compacted";

  constructor(point: number, message: string, compactedSeq?: number) {
    super(point, "", compactedSeq);
    this.message = message;
    this.name = "ServeCommitsCompactedError";
  }
}

/**
 * 503 with a `seq`: serve committed the change at `seq`, then could not
 * confirm it (its replica did not confirm the sync). It may already be in
 * the datastore, so it has `COMMIT_MAY_LAND_CODE`: running the command
 * again blindly could make it twice. `serveCode` is the code serve
 * answered with.
 */
export class ServeCommitMayLandError extends ServeUpstreamError {
  declare readonly code: typeof COMMIT_MAY_LAND_CODE;

  constructor(
    readonly seq: number,
    readonly serveCode: string | undefined,
    serveMessage: string,
  ) {
    super(
      503,
      COMMIT_MAY_LAND_CODE,
      `Serve committed this change at seq ${seq} but could not confirm it ` +
        `(${serveMessage}), so it may already be in the v3 datastore. ` +
        `The next command that writes in this checkout reads it back from ` +
        `serve; check it there (\`swamp data versions\`, \`swamp workflow ` +
        `history\`) before running this command again.`,
    );
    this.name = "ServeCommitMayLandError";
  }
}

/**
 * 429 that outlasted the client's retries, or that serve says not to retry
 * (`upload_quota_exceeded`, with no `Retry-After`).
 */
export class ServeRateLimitedError extends ServeUpstreamError {
  constructor(
    code: string,
    message: string,
    /** Serve's `Retry-After`, in seconds, when it sent one. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(429, code, message);
    this.name = "ServeRateLimitedError";
  }
}

/**
 * A chunk a commit names is not in this checkout's chunk cache, so the
 * commit cannot be sent: the commit's own failure, never serve's
 * (swamp-club#4195). An offline flush rejects the entry and keeps it.
 */
export class ChunkNotCachedError extends Error {
  constructor(readonly sha256: string, partition: string) {
    super(
      `Chunk ${sha256} of a commit to ${partition} is not in this ` +
        `checkout's chunk cache`,
    );
    this.name = "ChunkNotCachedError";
  }
}

/**
 * A reply whose body passed the bytes the client reads of it
 * (swamp-club#4062): serve is broken or hostile, and the body was
 * cancelled unread past the limit. `status` is the reply's.
 */
export class ServeReplyTooLargeError extends ServeUpstreamError {
  declare readonly code: "reply_too_large";

  constructor(
    status: number,
    /** The route the reply answered, as the client names it. */
    readonly route: string,
    /** The most bytes the client reads of this reply. */
    readonly maxBytes: number,
  ) {
    super(
      status,
      "reply_too_large",
      `Serve's reply to ${route} is larger than the ${maxBytes} bytes ` +
        `the client reads of it`,
    );
    this.name = "ServeReplyTooLargeError";
  }
}

/** Every reason a partition refuses a commit with, by name. */
const COMMIT_REJECTIONS: Readonly<Record<CommitRejection, true>> = {
  "partition-mismatch": true,
  "seq-gap": true,
  "stale-fence": true,
  "stale-lease": true,
  "lease-lost": true,
  "unfenced": true,
  "expect-failed": true,
  "version-live": true,
  "version-reused": true,
  "retry-expired": true,
};

function isCommitRejection(value: string): value is CommitRejection {
  return Object.hasOwn(COMMIT_REJECTIONS, value);
}

function recordKeyOrUndefined(value: string): RecordKey | undefined {
  try {
    return RecordKey.fromJSON(value);
  } catch {
    return undefined;
  }
}

function stringField(body: Record<string, unknown>, field: string) {
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

function seqField(body: Record<string, unknown>, field: string) {
  const value = body[field];
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0
    ? value
    : undefined;
}

/**
 * The error a serve datastore API reply that was not a success maps to.
 * `body` is the reply's parsed JSON, or undefined when it had none;
 * `serveUrl` the serve's `http(s)` origin, as the auth hint names it;
 * `retryAfterSeconds` the reply's `Retry-After`, if any.
 */
export function serveErrorFromReply(
  status: number,
  body: unknown,
  serveUrl: string,
  retryAfterSeconds?: number,
): Error {
  const fields = typeof body === "object" && body !== null &&
      !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const code = stringField(fields, "code");
  const message = stringField(fields, "message") ??
    `Serve at ${serveUrl} answered HTTP ${status}`;
  const seq = seqField(fields, "seq");
  if (status === 401) return new ServeAuthFailedError(serveUrl, message);
  if (status === 409) {
    if (code === "stale_seq" && seq !== undefined) {
      return new ServeStaleSeqError(seq, message);
    }
    const key = stringField(fields, "key");
    if (code === "precondition_failed" && key !== undefined) {
      return new ServePreconditionFailedError(
        key,
        seq ?? 0,
        stringField(fields, "changedBy"),
        stringField(fields, "changedAt"),
        message,
      );
    }
    if (code === "chunk_missing") {
      const missing = Array.isArray(fields.missing)
        ? fields.missing.filter((hash): hash is string =>
          typeof hash === "string"
        )
        : [];
      return new ServeChunksMissingError(missing, message);
    }
    if (code?.startsWith("commit_")) {
      const reason = code.slice("commit_".length);
      if (isCommitRejection(reason)) {
        return new ServeCommitRejectedError(reason, code, message);
      }
    }
  }
  if (
    status === 403 && (code === "forbidden" || code === "commit_refused")
  ) {
    const opIndex = fields.opIndex;
    return new ServeCommitRefusedError(
      code,
      stringField(fields, "reason"),
      typeof opIndex === "number" && Number.isSafeInteger(opIndex)
        ? opIndex
        : undefined,
      message,
    );
  }
  if (status === 410 && code === "commits_compacted") {
    const point = seqField(fields, "point");
    if (point !== undefined) {
      return new ServeCommitsCompactedError(point, message, seq);
    }
  }
  // Refused before it was taken (swamp-club#4096), so nothing may land:
  // checked before a 503's seq, which would say it might. A follower that
  // forwarded the request and lost the leader after it reached it says
  // `inFlight` (swamp-club#4120): the request may already have run.
  if (status === 503 && code === SERVE_NOT_LEADER_CODE) {
    const leader = typeof fields.leader === "object" && fields.leader !== null
      ? parseServeLeader(
        new TextEncoder().encode(JSON.stringify(fields.leader)),
      )
      : undefined;
    return new ServeNotLeaderError(leader, false, fields.inFlight === true);
  }
  if (status === 503 && seq !== undefined) {
    return new ServeCommitMayLandError(seq, code, message);
  }
  if (status === 429) {
    return new ServeRateLimitedError(
      code ?? "rate_limited",
      message,
      retryAfterSeconds,
    );
  }
  return new ServeUpstreamError(status, code ?? `http_${status}`, message);
}
