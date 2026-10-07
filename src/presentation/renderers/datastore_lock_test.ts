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
import type {
  DatastoreLockStatusData,
  DatastoreLockStatusEvent,
} from "../../libswamp/datastores/lock.ts";
import type { OutputMode } from "../output/output.ts";
import { createDatastoreLockStatusRenderer } from "./datastore_lock.ts";

function renderStatus(
  mode: OutputMode,
  data: DatastoreLockStatusData,
): string {
  const event: DatastoreLockStatusEvent = { kind: "completed", data };
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    createDatastoreLockStatusRenderer(mode).handlers().completed(event);
  } finally {
    console.log = origLog;
  }
  return output.join("\n");
}

const heldLock: DatastoreLockStatusData = {
  held: true,
  datastoreType: "filesystem",
  info: {
    holder: "testuser@testhost",
    hostname: "testhost",
    pid: 12345,
    acquiredAt: new Date().toISOString(),
    ttlMs: 30000,
    nonce: "abc-123",
  },
};

const lockBeingWritten: DatastoreLockStatusData = {
  held: true,
  datastoreType: "filesystem",
  info: {
    holder: "unknown (lock file is being written)",
    hostname: "unknown",
    pid: 0,
    acquiredAt: new Date().toISOString(),
    ttlMs: 30000,
    holderUnknown: true,
  },
};

Deno.test("datastoreLockStatusRenderer log: shows the holder's PID and hostname", () => {
  const output = renderStatus("log", heldLock);
  assertStringIncludes(output, "locked");
  assertStringIncludes(output, "Holder:   testuser@testhost");
  assertStringIncludes(output, "PID:      12345");
  assertStringIncludes(output, "Hostname: testhost");
});

Deno.test("datastoreLockStatusRenderer log: omits PID and hostname for a lock being written", () => {
  const output = renderStatus("log", lockBeingWritten);
  assertStringIncludes(output, "locked");
  assertStringIncludes(
    output,
    "Holder:   unknown (lock file is being written)",
  );
  assertStringIncludes(output, "Acquired:");
  assertStringIncludes(output, "TTL:      30000ms");
  assertEquals(output.includes("PID:"), false);
  assertEquals(output.includes("Hostname:"), false);
});

Deno.test("datastoreLockStatusRenderer json: carries the holderUnknown marker", () => {
  const parsed = JSON.parse(renderStatus("json", lockBeingWritten));
  assertEquals(parsed, lockBeingWritten);
});
