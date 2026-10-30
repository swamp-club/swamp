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
  DatastoreLockReleaseData,
  DatastoreLockStatusData,
  DatastoreLockStatusEvent,
} from "../../libswamp/datastores/lock.ts";
import type { OutputMode } from "../output/output.ts";
import {
  createDatastoreLockReleaseRenderer,
  createDatastoreLockStatusRenderer,
} from "./datastore_lock.ts";

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

Deno.test("datastoreLockStatusRenderer: shows a v3 writer lease's fence, and only then", () => {
  const lease: DatastoreLockStatusData = {
    ...heldLock,
    info: { ...heldLock.info!, fence: 7 },
  };
  assertStringIncludes(renderStatus("log", lease), "Fence:    7");
  assertEquals(renderStatus("log", heldLock).includes("Fence:"), false);
  assertEquals(JSON.parse(renderStatus("json", lease)).info.fence, 7);
});

function capture(fn: () => void): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return output.join("\n");
}

const serveLease = {
  lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
  heldBy: "other" as const,
  expiresAt: "2026-10-29T12:00:30.000Z",
};

Deno.test("createDatastoreLockStatusRenderer: a serve lease names its key and holder kind in log mode, never who (swamp-club#4121)", () => {
  const text = capture(() =>
    createDatastoreLockStatusRenderer("log").handlers().serve_lease({
      kind: "serve_lease",
      data: serveLease,
    })
  );
  assertStringIncludes(text, serveLease.lockKey);
  assertStringIncludes(text, "another caller");
  assertStringIncludes(text, serveLease.expiresAt);
});

Deno.test("createDatastoreLockStatusRenderer: serve leases ride on the one JSON document the status prints (swamp-club#4195)", () => {
  const handlers = createDatastoreLockStatusRenderer("json").handlers();
  const text = capture(() => {
    handlers.serve_lease({ kind: "serve_lease", data: serveLease });
    handlers.serve_leases_truncated({
      kind: "serve_leases_truncated",
      data: { truncated: true, listed: 512 },
    });
    handlers.completed({
      kind: "completed",
      data: { held: false, datastoreType: "filesystem" },
    });
  });
  assertEquals(JSON.parse(text), {
    held: false,
    datastoreType: "filesystem",
    serveLeases: [serveLease],
    serveLeasesTruncated: true,
  });
});

Deno.test("createDatastoreLockStatusRenderer: a status with no serve leases prints the lock alone in JSON", () => {
  const handlers = createDatastoreLockStatusRenderer("json").handlers();
  const text = capture(() =>
    handlers.completed({
      kind: "completed",
      data: { held: false, datastoreType: "filesystem" },
    })
  );
  assertEquals(JSON.parse(text), { held: false, datastoreType: "filesystem" });
});

function renderRelease(
  mode: OutputMode,
  data: DatastoreLockReleaseData,
): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    createDatastoreLockReleaseRenderer(mode).handlers().completed({
      kind: "completed",
      data,
    });
  } finally {
    console.log = origLog;
  }
  return output.join("\n");
}

Deno.test("datastore lock release renderer: a lease serve ended names who held it, in both modes (swamp-club#4195)", () => {
  const data: DatastoreLockReleaseData = {
    released: true,
    leaseHolder: "user:alice",
  };
  assertStringIncludes(renderRelease("log", data), "Lease held by: user:alice");
  assertEquals(JSON.parse(renderRelease("json", data)), data);
});
