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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { serverLoginHint } from "../../domain/auth/server_login_hint.ts";
import {
  COMMIT_MAY_LAND_CODE,
  COMMIT_PARTLY_COMMITTED_CODE,
  COMMIT_UNREACHABLE_CODE,
  RUN_PARTLY_COMMITTED_CODE,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../../domain/datastore_v3/litestream_replication.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  V3_SERVE_UNREACHABLE_CODE,
  V3_STORAGE_UNREACHABLE_CODE,
  V3_WRITER_BUSY_CODE,
  WRITER_FENCED_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  SERVE_NOT_LEADER_CODE,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";
import { UserError } from "../../domain/errors.ts";
import { isNetworkFailure } from "./network_failure.ts";
import {
  ServeAuthFailedError,
  ServeChunksMissingError,
  ServeCommitMayLandError,
  ServeCommitRefusedError,
  ServeCommitRejectedError,
  ServeCommitsCompactedError,
  serveErrorFromReply,
  ServePreconditionFailedError,
  ServeRateLimitedError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

const SERVE_URL = "https://serve.example.com";

Deno.test("ServeUnreachableError: says nothing changed when the request was never sent", () => {
  const cause = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (https://serve.example.com/x): client error (Connect): tcp connect error: Connection refused",
    ),
  });
  const error = new ServeUnreachableError(SERVE_URL, "never", cause);
  assertInstanceOf(error, UserError);
  assertEquals(error.message.includes("sends it again"), false);
  assertEquals(error.code, V3_SERVE_UNREACHABLE_CODE);
  assertEquals(error.code, "datastore_v3_serve_unreachable");
  assertEquals(error.sent, "never");
  assertEquals(error.cause, cause);
  assertEquals(error.message.includes(`serve at ${SERVE_URL}`), true);
  assertEquals(error.message.includes("the datastore was not changed"), true);
  assertEquals(
    error.message.includes(
      "never goes around serve to the datastore's storage",
    ),
    true,
  );
  // Read for a lock or a read as much as a write: it names no write.
  assertEquals(error.message.includes("refuses the write"), false);
  assertEquals(isNetworkFailure(error), true);
});

Deno.test("ServeUnreachableError: a request that may have been sent does not claim nothing changed", () => {
  const timeout = new DOMException("timed out", "TimeoutError");
  const error = new ServeUnreachableError(SERVE_URL, "maybe", timeout);
  assertEquals(error.sent, "maybe");
  assertEquals(error.message.includes("the datastore was not changed"), false);
  assertEquals(error.message.includes("may or may not"), true);
  assertEquals(
    error.message.includes(
      "the next command that writes in this checkout sends it again",
    ),
    true,
  );
  assertEquals(isNetworkFailure(error), true);
});

Deno.test("serveErrorFromReply: 409 stale_seq carries serve's head", () => {
  const error = serveErrorFromReply(409, {
    code: "stale_seq",
    seq: 12,
    message: "Partition p is at seq 12, not 10: catch up and retry",
  }, SERVE_URL);
  assertInstanceOf(error, ServeStaleSeqError);
  assertEquals(error.seq, 12);
  assertEquals(error.code, "stale_seq");
  assertEquals(error.status, 409);
  assertEquals(
    error.message,
    "Partition p is at seq 12, not 10: catch up and retry",
  );
});

Deno.test("serveErrorFromReply: 409 precondition_failed is an expect-failed CommitRejectedError with serve's message verbatim", () => {
  const message = "Updates were rejected: data/x was changed by user:bob";
  const error = serveErrorFromReply(409, {
    code: "precondition_failed",
    key: "data/x/raw",
    seq: 7,
    changedBy: "user:bob",
    changedAt: "2026-10-25T00:00:00Z",
    message,
  }, SERVE_URL);
  assertInstanceOf(error, ServePreconditionFailedError);
  assertInstanceOf(error, CommitRejectedError);
  assertEquals(error.reason, "expect-failed");
  assertEquals(error.message, message);
  assertEquals(error.key?.toString(), "data/x/raw");
  assertEquals(
    [error.recordKey, error.seq, error.changedBy, error.changedAt],
    ["data/x/raw", 7, "user:bob", "2026-10-25T00:00:00Z"],
  );
  // A local expect-failed refusal carries no code; neither does this.
  assertEquals((error as { code?: unknown }).code, undefined);
  const bare = serveErrorFromReply(409, {
    code: "precondition_failed",
    key: "data/y",
    seq: 3,
    message,
  }, SERVE_URL);
  assertInstanceOf(bare, ServePreconditionFailedError);
  assertEquals([bare.changedBy, bare.changedAt], [undefined, undefined]);
});

Deno.test("serveErrorFromReply: 409 writer fenced keeps the fenced code and serve's message", () => {
  const error = serveErrorFromReply(409, {
    code: WRITER_FENCED_CODE,
    message: "Another swamp process took over the writer lease",
  }, SERVE_URL);
  assertInstanceOf(error, ServeUpstreamError);
  assertEquals(error.code, WRITER_FENCED_CODE);
  assertEquals(
    error.message,
    "Another swamp process took over the writer lease",
  );
});

Deno.test("serveErrorFromReply: 503 serve_not_leader names the leader and never may land (swamp-club#4096)", () => {
  const error = serveErrorFromReply(503, {
    code: SERVE_NOT_LEADER_CODE,
    message: "not the leader",
    seq: 4,
    leader: {
      instanceId: "lead",
      fence: 3,
      address: "http://10.0.0.5:9090",
      since: "2026-10-28T12:00:00.000Z",
    },
  }, SERVE_URL);
  assertInstanceOf(error, ServeNotLeaderError);
  assertEquals(error.code, SERVE_NOT_LEADER_CODE);
  assertEquals(error.leader?.address, "http://10.0.0.5:9090");
});

Deno.test("serveErrorFromReply: 503 serve_not_leader without a readable leader names none", () => {
  const error = serveErrorFromReply(503, {
    code: SERVE_NOT_LEADER_CODE,
    leader: { instanceId: 3 },
  }, SERVE_URL);
  assertInstanceOf(error, ServeNotLeaderError);
  assertEquals(error.leader, undefined);
});

Deno.test("serveErrorFromReply: 503 with a seq may land, and keeps serve's code beside it", () => {
  const error = serveErrorFromReply(503, {
    code: V3_REPLICATION_UNCONFIRMED_CODE,
    message: "the replica did not confirm",
    seq: 9,
  }, SERVE_URL);
  assertInstanceOf(error, ServeCommitMayLandError);
  assertEquals(error.code, COMMIT_MAY_LAND_CODE);
  assertEquals(error.seq, 9);
  assertEquals(error.serveCode, V3_REPLICATION_UNCONFIRMED_CODE);
  assertEquals(error.message.includes("the replica did not confirm"), true);
  assertEquals(error.message.includes("seq 9"), true);
});

Deno.test("serveErrorFromReply: 503 without a seq keeps serve's code exactly", () => {
  for (
    const code of [
      COMMIT_UNREACHABLE_CODE,
      COMMIT_PARTLY_COMMITTED_CODE,
      RUN_PARTLY_COMMITTED_CODE,
      V3_REPLICATION_UNCONFIRMED_CODE,
      V3_STORAGE_UNREACHABLE_CODE,
      V3_WRITER_BUSY_CODE,
    ]
  ) {
    const error = serveErrorFromReply(
      503,
      { code, message: "away" },
      SERVE_URL,
    );
    assertInstanceOf(error, ServeUpstreamError);
    assertEquals([error.status, error.code, error.message], [
      503,
      code,
      "away",
    ]);
  }
});

Deno.test("serveErrorFromReply: 409 chunk_missing lists the missing hashes", () => {
  const missing = ["a".repeat(64), "b".repeat(64)];
  const error = serveErrorFromReply(409, {
    code: "chunk_missing",
    missing,
    message: "The commit names 2 chunk(s) the server does not hold",
  }, SERVE_URL);
  assertInstanceOf(error, ServeChunksMissingError);
  assertEquals(error.missing, missing);
  assertEquals(error.code, "chunk_missing");
});

Deno.test("serveErrorFromReply: other 409s and datastore_not_v3 keep serve's code and message", () => {
  for (
    const code of ["txn_id_reused", "content_changed", "datastore_not_v3"]
  ) {
    const error = serveErrorFromReply(
      409,
      { code, message: `m-${code}` },
      SERVE_URL,
    );
    assertInstanceOf(error, ServeUpstreamError);
    assertEquals([error.status, error.code, error.message], [
      409,
      code,
      `m-${code}`,
    ]);
  }
});

Deno.test("serveErrorFromReply: 409 commit_<reason> is a CommitRejectedError with that reason and serve's code", () => {
  const error = serveErrorFromReply(409, {
    code: "commit_stale-fence",
    message: "fence 3 is below 4",
  }, SERVE_URL);
  assertInstanceOf(error, ServeCommitRejectedError);
  assertInstanceOf(error, CommitRejectedError);
  assertEquals(error.reason, "stale-fence");
  assertEquals(error.code, "commit_stale-fence");
  assertEquals(error.message, "fence 3 is below 4");
  // A reason this client does not know stays serve's code, untyped.
  const unknown = serveErrorFromReply(409, {
    code: "commit_from-the-future",
    message: "new",
  }, SERVE_URL);
  assertInstanceOf(unknown, ServeUpstreamError);
  assertEquals(unknown.code, "commit_from-the-future");
});

Deno.test("serveErrorFromReply: 410 commits_compacted is a CommitsCompactedError at serve's point", () => {
  const error = serveErrorFromReply(410, {
    code: "commits_compacted",
    point: 40,
    message: "feed read: those commits were compacted (compaction point 40)",
  }, SERVE_URL);
  assertInstanceOf(error, ServeCommitsCompactedError);
  assertInstanceOf(error, CommitsCompactedError);
  assertEquals(error.point, 40);
  assertEquals(error.code, "commits_compacted");
  assertEquals(
    error.message,
    "feed read: those commits were compacted (compaction point 40)",
  );
});

Deno.test("serveErrorFromReply: 401 is a UserError naming server-login for the serve", () => {
  const error = serveErrorFromReply(401, {
    code: "unauthorized",
    message: "Unauthorized: token required",
  }, SERVE_URL);
  assertInstanceOf(error, ServeAuthFailedError);
  assertInstanceOf(error, UserError);
  assertEquals(error.message, serverLoginHint(SERVE_URL));
  assertEquals(error.serveMessage, "Unauthorized: token required");
  assertEquals(error.code, "unauthorized");
});

Deno.test("serveErrorFromReply: 403 forbidden and commit_refused carry serve's message and opIndex", () => {
  for (const code of ["forbidden", "commit_refused"]) {
    const error = serveErrorFromReply(403, {
      code,
      reason: "forbidden",
      opIndex: 2,
      message: "op 2 needs write on model:web",
    }, SERVE_URL);
    assertInstanceOf(error, ServeCommitRefusedError);
    assertEquals(
      [error.code, error.opIndex, error.reason, error.message],
      [code, 2, "forbidden", "op 2 needs write on model:web"],
    );
  }
});

Deno.test("serveErrorFromReply: 429 is a rate-limit error with serve's Retry-After", () => {
  const error = serveErrorFromReply(
    429,
    {
      code: "rate_limited",
      message: "Too Many Requests",
    },
    SERVE_URL,
    4,
  );
  assertInstanceOf(error, ServeRateLimitedError);
  assertEquals([error.code, error.retryAfterSeconds], ["rate_limited", 4]);
  const quota = serveErrorFromReply(429, {
    code: "upload_quota_exceeded",
    message: "Too many uploaded chunks",
  }, SERVE_URL);
  assertInstanceOf(quota, ServeRateLimitedError);
  assertEquals([quota.code, quota.retryAfterSeconds], [
    "upload_quota_exceeded",
    undefined,
  ]);
});

Deno.test("serveErrorFromReply: anything else is a generic error with its status and code", () => {
  const error = serveErrorFromReply(413, {
    code: "envelope_too_large",
    message: "too big",
  }, SERVE_URL);
  assertInstanceOf(error, ServeUpstreamError);
  assertEquals([error.status, error.code, error.message], [
    413,
    "envelope_too_large",
    "too big",
  ]);
  const bodiless = serveErrorFromReply(502, undefined, SERVE_URL);
  assertInstanceOf(bodiless, ServeUpstreamError);
  assertEquals([bodiless.status, bodiless.code], [502, "http_502"]);
  assertEquals(bodiless.message, `Serve at ${SERVE_URL} answered HTTP 502`);
});
