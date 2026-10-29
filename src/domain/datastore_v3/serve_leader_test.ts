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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  advertiseAddressInCleartext,
  normalizeAdvertiseAddress,
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

Deno.test("normalizeAdvertiseAddress: an http(s) origin, loopback included", () => {
  assertEquals(
    normalizeAdvertiseAddress("https://node-1.internal:9090/"),
    "https://node-1.internal:9090",
  );
  assertEquals(
    normalizeAdvertiseAddress("http://127.0.0.1:9091"),
    "http://127.0.0.1:9091",
  );
  assertEquals(
    normalizeAdvertiseAddress("http://[fd00::1]:9090"),
    "http://[fd00::1]:9090",
  );
});

Deno.test("normalizeAdvertiseAddress: refuses what names no node or carries more than an origin", () => {
  for (
    const address of [
      "node-1:9090",
      "ws://node-1:9090",
      "https://user:pw@node-1:9090",
      "https://node-1:9090/serve",
      "https://node-1:9090?x=1",
      "http://0.0.0.0:9090",
      "http://[::]:9090",
      "not a url",
    ]
  ) {
    assertThrows(() => normalizeAdvertiseAddress(address), UserError);
  }
});

Deno.test("ServeNotLeaderError: an in-flight refusal says the request may have run, not that nothing changed", () => {
  const error = new ServeNotLeaderError(undefined, false, true);
  assertEquals(error.code, SERVE_NOT_LEADER_CODE);
  assertEquals(error.inFlight, true);
  assertEquals(error.message.includes("Nothing was changed"), false);
  assertEquals(error.message.includes("may already have run"), true);
  assertEquals(new ServeNotLeaderError(undefined).inFlight, false);
});

Deno.test("advertiseAddressInCleartext: plain http to a host that is not loopback", () => {
  assertEquals(advertiseAddressInCleartext("http://10.0.0.5:9090"), true);
  assertEquals(
    advertiseAddressInCleartext("http://node-1.internal:9090"),
    true,
  );
  assertEquals(
    advertiseAddressInCleartext("https://node-1.internal:9090"),
    false,
  );
  assertEquals(advertiseAddressInCleartext("http://127.0.0.1:9090"), false);
  assertEquals(advertiseAddressInCleartext("http://localhost:9090"), false);
  assertEquals(advertiseAddressInCleartext("http://[::1]:9090"), false);
  // A host name that merely starts with 127 is not loopback.
  assertEquals(advertiseAddressInCleartext("http://127.example.com"), true);
});
