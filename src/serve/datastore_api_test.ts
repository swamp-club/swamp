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

import { assertEquals } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import {
  COMMIT_PARTLY_COMMITTED_CODE,
  COMMIT_UNREACHABLE_CODE,
  RUN_PARTLY_COMMITTED_CODE,
} from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { CommitsCompactedError } from "../domain/datastore_v3/commit_store.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../domain/datastore_v3/litestream_replication.ts";
import {
  V3_STORAGE_UNREACHABLE_CODE,
  V3_WRITER_BUSY_CODE,
  V3StorageUnreachableError,
  WriterFencedError,
} from "../domain/datastore_v3/writer_lease.ts";
import { modelPartition } from "../domain/datastore_v3/v3_test_helpers.ts";
import {
  ChunksMissingError,
  PreconditionConflictError,
  StaleSeqError,
  TxnIdReusedError,
} from "../infrastructure/datastore_v3/forwarded_commit.ts";
import { ChunkHashMismatchError } from "../infrastructure/datastore_v3/chunk_ingest.ts";
import { datastoreErrorResponse } from "./datastore_api.ts";
import {
  datastoreRouteTemplate,
  matchDatastoreRoute,
} from "./datastore_routes.ts";
import { resolveHttpRoute } from "./http_request_span.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

Deno.test("matchDatastoreRoute: each route, with its segments decoded once", () => {
  const partition = modelPartition().toString();
  assertEquals(matchDatastoreRoute("/api/v1/datastore/_default/chunks/has"), {
    kind: "has",
    namespace: "_default",
  });
  assertEquals(
    matchDatastoreRoute(`/api/v1/datastore/ns/chunks/${"a".repeat(64)}`),
    { kind: "chunk", namespace: "ns", sha256: "a".repeat(64) },
  );
  assertEquals(
    matchDatastoreRoute(
      `/api/v1/datastore/ns/partitions/${
        encodeURIComponent(partition)
      }/commits`,
    ),
    { kind: "commits", namespace: "ns", partition },
  );
  assertEquals(matchDatastoreRoute("/api/v1/datastore/ns/changes"), {
    kind: "changes",
    namespace: "ns",
  });
  assertEquals(matchDatastoreRoute("/api/v1/datastore/ns/locks"), {
    kind: "locks",
    namespace: "ns",
  });
  assertEquals(matchDatastoreRoute("/api/v1/datastore/ns/locks/lease-1"), {
    kind: "lease",
    namespace: "ns",
    leaseId: "lease-1",
  });
});

Deno.test("matchDatastoreRoute: anything else is not a datastore route", () => {
  for (
    const path of [
      "/api/v1/datastore/",
      "/api/v1/datastore/ns",
      "/api/v1/datastore/ns/chunks",
      "/api/v1/datastore/ns/partitions/p",
      "/api/v1/datastore/ns/changes/extra",
      "/api/v1/datastore/ns/locks/lease-1/extra",
      "/api/v1/datastore/%E0%A4%A/changes",
      "/api/v1/health",
    ]
  ) {
    assertEquals(matchDatastoreRoute(path), undefined, path);
  }
});

Deno.test("resolveHttpRoute: datastore paths are named by their template, never their segments", () => {
  const route = matchDatastoreRoute(
    `/api/v1/datastore/ns/chunks/${"b".repeat(64)}`,
  );
  assertEquals(
    resolveHttpRoute(`/api/v1/datastore/ns/chunks/${"b".repeat(64)}`),
    datastoreRouteTemplate(route!),
  );
  assertEquals(
    resolveHttpRoute("/api/v1/datastore/ns/changes"),
    "/api/v1/datastore/{namespace}/changes",
  );
  assertEquals(
    resolveHttpRoute(`/api/v1/datastore/ns/locks/${crypto.randomUUID()}`),
    "/api/v1/datastore/{namespace}/locks/{leaseId}",
  );
});

async function reply(
  error: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = datastoreErrorResponse(error);
  return { status: response.status, body: await response.json() };
}

Deno.test("datastoreErrorResponse: conflicts are 409s a client can act on", async () => {
  const stale = await reply(new StaleSeqError(modelPartition(), 2, 5));
  assertEquals(stale.status, 409);
  assertEquals(stale.body.code, "stale_seq");
  assertEquals(stale.body.seq, 5);
  const precondition = await reply(
    new PreconditionConflictError(
      "data/x",
      7,
      "user:bob",
      "2026-10-25T00:00:00Z",
    ),
  );
  assertEquals(precondition.status, 409);
  assertEquals(precondition.body.code, "precondition_failed");
  assertEquals(precondition.body.changedBy, "user:bob");
  assertEquals(precondition.body.key, "data/x");
  const reused = await reply(new TxnIdReusedError("t"));
  assertEquals([reused.status, reused.body.code], [409, "txn_id_reused"]);
  const missing = await reply(new ChunksMissingError(["c".repeat(64)]));
  assertEquals([missing.status, missing.body.code], [
    409,
    "chunk_missing",
  ]);
});

Deno.test("datastoreErrorResponse: the writer's errors keep the codes serve's other replies use", async () => {
  const fenced = await reply(new WriterFencedError(1, 2));
  assertEquals([fenced.status, fenced.body.code], [
    409,
    "datastore_v3_writer_fenced",
  ]);
  for (
    const code of [
      COMMIT_UNREACHABLE_CODE,
      COMMIT_PARTLY_COMMITTED_CODE,
      RUN_PARTLY_COMMITTED_CODE,
      V3_REPLICATION_UNCONFIRMED_CODE,
    ]
  ) {
    const mapped = await reply(new UserError("storage is away", code));
    assertEquals([mapped.status, mapped.body.code], [503, code]);
  }
});

Deno.test("datastoreErrorResponse: a writer cut off from its storage or refused its lease answers 503 with its code", async () => {
  const unreachable = await reply(
    new V3StorageUnreachableError("s3://bucket", new Error("connect refused")),
  );
  assertEquals([unreachable.status, unreachable.body.code], [
    503,
    V3_STORAGE_UNREACHABLE_CODE,
  ]);
  const busy = await reply(
    new UserError("Another swamp process is writing", V3_WRITER_BUSY_CODE),
  );
  assertEquals([busy.status, busy.body.code], [503, V3_WRITER_BUSY_CODE]);
  // A plain error carrying the code is not one of the writer's own errors,
  // so its detail stays hidden.
  const forged = Object.assign(new Error("/secret/path"), {
    code: V3_WRITER_BUSY_CODE,
  });
  const hidden = await reply(forged);
  assertEquals([hidden.status, hidden.body.code, hidden.body.message], [
    500,
    "internal_error",
    "Internal error",
  ]);
});

Deno.test("datastoreErrorResponse: compaction is 410, a bad chunk 400, and anything else hides its detail", async () => {
  const compacted = await reply(new CommitsCompactedError(40, "compacted"));
  assertEquals([compacted.status, compacted.body.code, compacted.body.point], [
    410,
    "commits_compacted",
    40,
  ]);
  const mismatch = await reply(
    new ChunkHashMismatchError("d".repeat(64), "e".repeat(64)),
  );
  assertEquals([mismatch.status, mismatch.body.code], [
    400,
    "chunk_hash_mismatch",
  ]);
  const internal = await reply(new Error("/secret/path/commits.db is locked"));
  assertEquals(internal.status, 500);
  assertEquals(internal.body.message, "Internal error");
});
