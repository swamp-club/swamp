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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseServeLeader,
  serializeServeLeader,
  SERVE_NOT_LEADER_CODE,
  type ServeLeader,
  ServeNotLeaderError,
} from "./serve_leader.ts";

const leader: ServeLeader = {
  instanceId: "a1",
  fence: 7,
  address: "http://10.0.0.2:9090",
  since: "2026-10-28T12:00:00.000Z",
};

Deno.test("parseServeLeader: round-trips a record", () => {
  assertEquals(parseServeLeader(serializeServeLeader(leader)), leader);
  const { address: _, ...noAddress } = leader;
  assertEquals(parseServeLeader(serializeServeLeader(noAddress)), noAddress);
});

Deno.test("parseServeLeader: refuses what is not a leader record", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  for (
    const bad of [
      new TextEncoder().encode("not json"),
      encode(null),
      encode({ ...leader, instanceId: "" }),
      encode({ ...leader, fence: 0 }),
      encode({ ...leader, fence: 1.5 }),
      encode({ ...leader, since: "yesterday" }),
      encode({ ...leader, address: 9 }),
    ]
  ) {
    assertEquals(parseServeLeader(bad), undefined);
  }
});

Deno.test("ServeNotLeaderError: names the leader and is retryable by code", () => {
  const error = new ServeNotLeaderError(leader);
  assertEquals(error.code, SERVE_NOT_LEADER_CODE);
  assertStringIncludes(error.message, "instance a1 at http://10.0.0.2:9090");
  assertStringIncludes(error.message, "did not take the request");
});

Deno.test("ServeNotLeaderError: says the leader is not known when none is named", () => {
  assertStringIncludes(
    new ServeNotLeaderError(undefined).message,
    "not known yet",
  );
  assertStringIncludes(
    new ServeNotLeaderError(undefined, true).message,
    "its copy is behind",
  );
});
