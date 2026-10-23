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

import { assertEquals, assertRejects } from "@std/assert";
import {
  V3StorageUnreachableError,
  WriterFencedError,
} from "../domain/datastore_v3/writer_lease.ts";
import {
  ReadModelApplyError,
  ReadModelCatchUpUnreachableError,
} from "../domain/datastore_v3/read_model.ts";
import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";
import {
  closeV3DatastoresAfterFailure,
  closeV3DatastoresAfterSuccess,
} from "./v3_teardown.ts";
import {
  CommitUnreachableError,
  RunPartlyCommittedError,
} from "../domain/datastore_v3/commit_log_unit_of_work.ts";

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
