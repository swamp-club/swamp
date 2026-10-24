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
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  V3StorageUnreachableError,
  WriterFencedError,
} from "../domain/datastore_v3/writer_lease.ts";
import {
  ReadModelApplyError,
  ReadModelCatchUpUnreachableError,
} from "../domain/datastore_v3/read_model.ts";
import {
  V3_REPLICATION_UNAVAILABLE_CODE,
  V3ReplicationError,
  V3ReplicationUnavailableError,
} from "../domain/datastore_v3/litestream_replication.ts";
import {
  closeV3DatastoresAfterFailure,
  closeV3DatastoresAfterSuccess,
} from "./v3_teardown.ts";
import { reportedV3Failure } from "../infrastructure/datastore_v3/v3_repo_context.ts";
import {
  CommitUnreachableError,
  MayLandLaterError,
  RunPartlyCommittedError,
} from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { V3_STORAGE_UNREACHABLE_CODE } from "../domain/datastore_v3/writer_lease.ts";
import { exitCodeForError } from "../presentation/output/error_output.ts";

/** A command that committed nothing to the datastore at `/ds`. */
const NOTHING_COMMITTED = { committed: false, datastorePath: "/ds" } as const;
const COMMITTED = { committed: true } as const;

/** A lineage the bucket could not be reached to record, as the reporter's. */
function lineageCutOff(): V3ReplicationError {
  const lost = new Error("S3 putObjectConditional failed key=lineage/1", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  return new V3ReplicationError(
    `the replication lineage of this writer could not be recorded: ${lost.message}`,
    { cause: lost },
  );
}

Deno.test("closeV3DatastoresAfterSuccess: commits a sync did not confirm fail the command", async () => {
  await assertRejects(
    () =>
      closeV3DatastoresAfterSuccess(() =>
        Promise.reject(new V3ReplicationError("the sync timed out"))
      ),
    V3ReplicationError,
  );
});

Deno.test("closeV3DatastoresAfterSuccess: any other close failure is only logged", async () => {
  await closeV3DatastoresAfterSuccess(() =>
    Promise.reject(new Error("release failed"))
  );
  await closeV3DatastoresAfterSuccess(() => Promise.resolve());
});

Deno.test("closeV3DatastoresAfterSuccess: a writer fenced during its closing sync fails the command", async () => {
  const fenced = new V3ReplicationError(
    "this process lost its writer lease while the sync ran",
    { cause: new WriterFencedError(3, 4) },
  );
  const error = await assertRejects(
    () => closeV3DatastoresAfterSuccess(() => Promise.reject(fenced)),
    V3ReplicationError,
  );
  assertEquals(error.cause instanceof WriterFencedError, true);
});

Deno.test("closeV3DatastoresAfterFailure: a commit that could not reach the storage tells the close the storage is unreachable (swamp-club#3759, swamp-club#3802)", async () => {
  const closes: { storageUnreachable?: boolean }[] = [];
  await closeV3DatastoresAfterFailure(
    new Error("Method execution failed", {
      cause: new CommitUnreachableError(new Error("refused")),
    }),
    (options) => {
      closes.push(options);
      return Promise.resolve();
    },
  );
  assertEquals(closes, [{ storageUnreachable: true }]);
});

Deno.test("closeV3DatastoresAfterFailure: a partly committed run, a hold and a catch-up cut off from the storage also tell the close so (swamp-club#3802)", async () => {
  const errors = [
    new RunPartlyCommittedError(new Error("refused"), [
      { workflowId: "wf", runId: "run" },
    ]),
    new V3StorageUnreachableError("/ds", new Error("ECONNRESET")),
    new ReadModelCatchUpUnreachableError(
      new ReadModelApplyError("", "p", 1, "error reading a body"),
    ),
  ];
  for (const error of errors) {
    const closes: { storageUnreachable?: boolean }[] = [];
    await closeV3DatastoresAfterFailure(error, (options) => {
      closes.push(options);
      return Promise.resolve();
    });
    assertEquals(closes, [{ storageUnreachable: true }], error.name);
  }
});

Deno.test("closeV3DatastoresAfterFailure: any other failure closes as usual, and a close error is swallowed (swamp-club#3759)", async () => {
  const closes: { storageUnreachable?: boolean }[] = [];
  await closeV3DatastoresAfterFailure(
    new Error("operation failed"),
    (options) => {
      closes.push(options);
      return Promise.reject(new Error("lease release failed"));
    },
  );
  assertEquals(closes, [{ storageUnreachable: false }]);
});

Deno.test("reportedV3Failure: a command that committed nothing and could not reach the storage reports storage-unreachable, exit 75, nothing changed (swamp-club#3882)", () => {
  const reported = reportedV3Failure(lineageCutOff(), NOTHING_COMMITTED);
  assert(reported instanceof V3StorageUnreachableError, String(reported));
  assertEquals(reported.code, V3_STORAGE_UNREACHABLE_CODE);
  assertEquals(exitCodeForError(reported), 75);
  assertStringIncludes(reported.message, "nothing was changed");
  assertStringIncludes(reported.message, "/ds");
  assertStringIncludes(reported.message, "putObjectConditional");
  assert(!reported.message.includes("saved locally"), reported.message);
});

Deno.test("reportedV3Failure: a command that committed nothing and failed otherwise keeps its cause, worded as nothing changed (swamp-club#3882)", () => {
  const claimed = new V3ReplicationError(
    "the replication lineage of this writer could not be recorded: " +
      "replication lineage 00000001 was already claimed under another " +
      "replica root",
    { cause: new Error("already claimed") },
  );
  const reported = reportedV3Failure(claimed, NOTHING_COMMITTED);
  assert(reported instanceof V3ReplicationUnavailableError, String(reported));
  assertEquals(reported.code, V3_REPLICATION_UNAVAILABLE_CODE);
  assertStringIncludes(reported.message, "already claimed under another");
  assertStringIncludes(reported.message, "Nothing was changed.");
  assert(!reported.message.includes("saved locally"), reported.message);
});

Deno.test("reportedV3Failure: a command that committed keeps the saved-locally error, and every other error passes unchanged (swamp-club#3882)", () => {
  const unconfirmed = lineageCutOff();
  assertStrictEquals(reportedV3Failure(unconfirmed, COMMITTED), unconfirmed);
  for (
    const other of [
      new MayLandLaterError(new Error("refused"), "the outbox"),
      new CommitUnreachableError(new Error("refused")),
      new V3StorageUnreachableError("/ds", new Error("ECONNRESET")),
      new Error("plain"),
    ]
  ) {
    assertStrictEquals(reportedV3Failure(other, NOTHING_COMMITTED), other);
  }
});

Deno.test("closeV3DatastoresAfterFailure: resolves with the reported error, read before the close, and tells the close the storage is unreachable (swamp-club#3882)", async () => {
  const closes: { storageUnreachable?: boolean }[] = [];
  let closed = false;
  const reported = await closeV3DatastoresAfterFailure(
    lineageCutOff(),
    (options) => {
      closes.push(options);
      closed = true;
      return Promise.resolve();
    },
    () => {
      assertEquals(closed, false, "read after the close");
      return NOTHING_COMMITTED;
    },
  );
  assert(reported instanceof V3StorageUnreachableError, String(reported));
  assertEquals(closes, [{ storageUnreachable: true }]);
});

Deno.test("closeV3DatastoresAfterSuccess: a closing sync that fails for a command that committed nothing says nothing changed (swamp-club#3882)", async () => {
  let closed = false;
  const error = await assertRejects(
    () =>
      closeV3DatastoresAfterSuccess(
        () => {
          closed = true;
          return Promise.reject(lineageCutOff());
        },
        () => {
          assertEquals(closed, false, "read after the close");
          return NOTHING_COMMITTED;
        },
      ),
    V3StorageUnreachableError,
  );
  assertStringIncludes(
    error.message,
    "while confirming its replica as the command ended, so nothing was " +
      "changed",
  );
  await assertRejects(
    () =>
      closeV3DatastoresAfterSuccess(
        () => Promise.reject(lineageCutOff()),
        () => COMMITTED,
      ),
    V3ReplicationError,
    "saved locally",
  );
});
