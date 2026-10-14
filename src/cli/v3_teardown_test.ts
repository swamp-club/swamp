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
import { WriterFencedError } from "../domain/datastore_v3/writer_lease.ts";
import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";
import { closeV3DatastoresAfterSuccess } from "./v3_teardown.ts";

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
