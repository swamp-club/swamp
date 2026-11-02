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
 * each serve refusal maps to the error a local commit would give, so a caller
 * handles both alike; serve's message is kept verbatim, and shared codes are
 * kept so the exit code matches a local run
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
  SERVE_FOLLOWER_BEHIND_CODE,
  SERVE_NOT_LEADER_CODE,
  ServeFollowerBehindError,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";

export { V3_SERVE_UNREACHABLE_CODE };

export type ServeRequestSent = "never" | "maybe";

/**
 * sent "never" means the connection was never made, so serve changed nothing;
 * "maybe" means it may have reached serve. Nothing goes around serve to the
 * datastore's storage, which is never reached another way
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
 * a read in a checkout that never read from serve, while serve is unreachable:
 * its copy is empty, so an empty answer would look like an empty datastore.
 * Exits 75
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

export const SERVE_UPSTREAM_DIVERGED_CODE = "serve_upstream_diverged";

export interface ServeDivergedCommit {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string | undefined;
}

export type ServeDivergence =
  | {
    readonly kind: "other-log";
    readonly copyLogId: string;
    readonly serveLogId: string;
  }
  | { readonly kind: "behind"; readonly serveHead: number }
  | { readonly kind: "other-commit"; readonly serveTxnId: string };

/**
 * serve at the address does not serve the log the copy follows (another log id,
 * or a restore to an earlier point); the copy is never re-synced on its own, as
 * it may hold commits a restore needs
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

export const SERVE_UPSTREAM_UPGRADE_REQUIRED_CODE =
  "serve_upstream_upgrade_required";

/**
 * a serve too old to send its log id: the checkout cannot tell whether it still
 * serves the log its copy follows, so the reply is not used
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

export class ServeUpstreamError extends UserError {
  declare readonly code: string;

  constructor(readonly status: number, code: string, message: string) {
    super(message, code);
    this.name = "ServeUpstreamError";
  }
}

export class ServeAuthFailedError extends ServeUpstreamError {
  constructor(readonly serveUrl: string, readonly serveMessage: string) {
    super(401, "unauthorized", serverLoginHint(serveUrl));
    this.name = "ServeAuthFailedError";
  }
}

export class ServeStaleSeqError extends ServeUpstreamError {
  declare readonly code: "stale_seq";

  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(409, "stale_seq", message);
    this.name = "ServeStaleSeqError";
  }
}

/**
 * a record the commit expected changed since the caller read it: a
 * CommitRejectedError with reason expect-failed, carrying no code, as a local
 * refusal does, and serve's message verbatim
 */
export class ServePreconditionFailedError extends CommitRejectedError {
  readonly status = 409;

  constructor(
    readonly recordKey: string,
    readonly seq: number,
    readonly changedBy: string | undefined,
    readonly changedAt: string | undefined,
    message: string,
  ) {
    super("expect-failed", message, recordKeyOrUndefined(recordKey));
    this.name = "ServePreconditionFailedError";
  }
}

export class ServeCommitRejectedError extends CommitRejectedError {
  readonly status = 409;

  constructor(reason: CommitRejection, readonly code: string, message: string) {
    super(reason, message);
    this.name = "ServeCommitRejectedError";
  }
}

export class ServeChunksMissingError extends ServeUpstreamError {
  declare readonly code: "chunk_missing";

  constructor(readonly missing: readonly string[], message: string) {
    super(409, "chunk_missing", message);
    this.name = "ServeChunksMissingError";
  }
}

export class ServeCommitRefusedError extends ServeUpstreamError {
  constructor(
    code: string,
    readonly reason: string | undefined,
    readonly opIndex: number | undefined,
    message: string,
  ) {
    super(403, code, message);
    this.name = "ServeCommitRefusedError";
  }
}

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
 * serve committed at `seq` but could not confirm it, so it may already be in
 * the datastore; COMMIT_MAY_LAND_CODE warns that running the command again
 * blindly could make it twice
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

export class ServeRateLimitedError extends ServeUpstreamError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(429, code, message);
    this.name = "ServeRateLimitedError";
  }
}

/**
 * a chunk a commit names is not in this checkout's chunk cache, so the commit
 * cannot be sent: the commit's own failure, never serve's; an offline flush
 * rejects the entry and keeps it
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
 * a reply body past the bytes the client reads: serve is broken or hostile, and
 * the body was cancelled unread
 */
export class ServeReplyTooLargeError extends ServeUpstreamError {
  declare readonly code: "reply_too_large";

  constructor(
    status: number,
    readonly route: string,
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
  // refused before it was taken, so nothing may land; checked before a 503's
  // seq, which would say it might. A follower that lost the leader after
  // forwarding says `inFlight`: the request may already have run
  if (status === 503 && code === SERVE_NOT_LEADER_CODE) {
    const leader = typeof fields.leader === "object" && fields.leader !== null
      ? parseServeLeader(
        new TextEncoder().encode(JSON.stringify(fields.leader)),
      )
      : undefined;
    return new ServeNotLeaderError(leader, false, fields.inFlight === true);
  }
  // a follower behind the caller's copy refused a read while it catches up:
  // retryable, never divergence, and nothing landed
  if (status === 503 && code === SERVE_FOLLOWER_BEHIND_CODE) {
    return new ServeFollowerBehindError();
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
