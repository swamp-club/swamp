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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  datastoreGc,
  type DatastoreGcChunkReport,
  type DatastoreGcEvent,
} from "./gc.ts";

const REPORT: DatastoreGcChunkReport = {
  scanned: 5,
  referenced: 2,
  deleted: 3,
  restored: 0,
  keptTooNew: 0,
  keptOverBudget: 0,
  damaged: 0,
  tempFilesRemoved: 1,
};

Deno.test("datastoreGc: a v2 datastore has no chunks to collect", async () => {
  const events = await collect<DatastoreGcEvent>(
    datastoreGc(createLibSwampContext(), {}),
  );
  assertEquals(events, [{ kind: "completed", data: { applies: false } }]);
});

Deno.test("datastoreGc: a v3 datastore sweeps its chunks and reports what it did", async () => {
  let swept = 0;
  const events = await collect<DatastoreGcEvent>(
    datastoreGc(createLibSwampContext(), {
      collectChunks: () => {
        swept++;
        return Promise.resolve(REPORT);
      },
    }),
  );
  assertEquals(swept, 1);
  assertEquals(events, [
    { kind: "collecting" },
    { kind: "completed", data: { applies: true, chunks: REPORT } },
  ]);
});
