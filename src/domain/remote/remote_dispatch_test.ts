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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  isRemoteOnlyMode,
  remoteOutputsOf,
  setRemoteOnlyMode,
  withRemoteOutputs,
} from "./remote_dispatch.ts";
import type { DispatchOutput } from "./protocol.ts";

Deno.test("setRemoteOnlyMode: defaults to false", () => {
  setRemoteOnlyMode(false);
  assertEquals(isRemoteOnlyMode(), false);
});

Deno.test("setRemoteOnlyMode: can be enabled", () => {
  setRemoteOnlyMode(true);
  assertEquals(isRemoteOnlyMode(), true);
  setRemoteOnlyMode(false);
});

Deno.test("setRemoteOnlyMode: can be disabled after enabling", () => {
  setRemoteOnlyMode(true);
  assertEquals(isRemoteOnlyMode(), true);
  setRemoteOnlyMode(false);
  assertEquals(isRemoteOnlyMode(), false);
});

const output: DispatchOutput = {
  dataId: "d-1",
  version: 2,
  name: "result",
  specName: "result",
  type: "resource",
};

Deno.test("withRemoteOutputs: round-trips the outputs on the same error", () => {
  const error = new Error("boom");
  const carried = withRemoteOutputs(error, [output]);
  assertStrictEquals(carried, error);
  assertEquals(remoteOutputsOf(carried), [output]);
  assertEquals(Object.keys(error).includes("remoteOutputs"), false);
});

Deno.test("withRemoteOutputs: an empty list attaches nothing", () => {
  const error = new Error("boom");
  withRemoteOutputs(error, []);
  assertEquals("remoteOutputs" in error, false);
  assertEquals(remoteOutputsOf(error), []);
});

Deno.test("withRemoteOutputs: a primitive or frozen error is returned unchanged", () => {
  assertEquals(withRemoteOutputs("boom", [output]), "boom");
  const frozen = Object.freeze(new Error("boom"));
  assertStrictEquals(withRemoteOutputs(frozen, [output]), frozen);
  assertEquals(remoteOutputsOf(frozen), []);
});

Deno.test("remoteOutputsOf: drops entries without the fields an output is identified by", () => {
  const error = Object.assign(new Error("boom"), {
    remoteOutputs: [output, { name: "x" }, null, { ...output, type: "other" }],
  });
  assertEquals(remoteOutputsOf(error), [output]);
  assertEquals(remoteOutputsOf(undefined), []);
});
