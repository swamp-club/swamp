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

import { assertEquals, assertThrows } from "@std/assert";
import {
  decideLineage,
  parseReplicationLineage,
  replicaPathFor,
  type ReplicationLineage,
} from "./replication_lineage.ts";

const ROOT = "/replica";

function lineage(
  lineageFence: number,
  lastFence: number,
  previousLineages: number[] = [],
  replicaRoot = ROOT,
): ReplicationLineage {
  return { replicaRoot, lineageFence, lastFence, previousLineages };
}

Deno.test("decideLineage: no record starts a new lineage at the fence", () => {
  assertEquals(decideLineage(undefined, ROOT, 7), {
    kind: "new",
    lineage: lineage(7, 7),
  });
});

Deno.test("decideLineage: the next fence continues the lineage", () => {
  assertEquals(decideLineage(lineage(3, 5), ROOT, 6), {
    kind: "continue",
    lineage: lineage(3, 6),
  });
});

Deno.test("decideLineage: the same fence again changes nothing", () => {
  const previous = lineage(3, 5);
  const decision = decideLineage(previous, ROOT, 5);
  assertEquals(decision.kind, "continue");
  assertEquals(decision.lineage, previous);
});

Deno.test("decideLineage: another writer's fence in between restarts at this fence", () => {
  assertEquals(decideLineage(lineage(3, 5, [1]), ROOT, 8), {
    kind: "restart",
    lineage: lineage(8, 8, [1, 3]),
  });
});

Deno.test("decideLineage: a different replica root restarts even on the next fence", () => {
  assertEquals(decideLineage(lineage(3, 5), "/other", 6), {
    kind: "restart",
    lineage: lineage(6, 6, [3], "/other"),
  });
});

Deno.test("decideLineage: a crashed command's successor continues its lineage", () => {
  // The crashed command recorded fence 6 when it took the lease.
  const crashed = decideLineage(lineage(3, 5), ROOT, 6).lineage;
  assertEquals(decideLineage(crashed, ROOT, 7).lineage, lineage(3, 7));
});

Deno.test("decideLineage: refuses an invalid fence", () => {
  assertThrows(() => decideLineage(undefined, ROOT, 0));
  assertThrows(() => decideLineage(undefined, ROOT, 1.5));
});

Deno.test("replicaPathFor: names the lineage by its padded fence", () => {
  assertEquals(
    replicaPathFor("/replica", 12),
    "/replica/_litestream/000000000012",
  );
  assertEquals(
    replicaPathFor("/replica/", 1),
    "/replica/_litestream/000000000001",
  );
});

Deno.test("parseReplicationLineage: reads back a record and rejects anything else", () => {
  const record = lineage(3, 5, [1, 2]);
  assertEquals(
    parseReplicationLineage(JSON.parse(JSON.stringify(record))),
    record,
  );
  assertEquals(parseReplicationLineage(null), undefined);
  assertEquals(parseReplicationLineage({ ...record, lastFence: 0 }), undefined);
  assertEquals(
    parseReplicationLineage({ ...record, previousLineages: ["1"] }),
    undefined,
  );
  assertEquals(
    parseReplicationLineage({ ...record, replicaRoot: 1 }),
    undefined,
  );
});
