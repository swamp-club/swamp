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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { serveFingerprint, type ServeFingerprintDeps } from "./fingerprint.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";

function worker(status: string, swampVersion: string, labels = {}) {
  return {
    attributes: {
      name: `w-${crypto.randomUUID()}`,
      instanceUuid: crypto.randomUUID(),
      tokenName: "t",
      status,
      labels,
      platform: "linux",
      arch: "x86_64",
      swampVersion,
      protocolVersion: 1,
      enrolledAt: "2026-11-26T00:00:00.000Z",
      lastSeenAt: "2026-11-26T00:00:00.000Z",
    },
  } as unknown as DataRecord;
}

function deps(records: DataRecord[]): ServeFingerprintDeps {
  return {
    buildVersion: () => "v",
    platform: () => ({ platform: "linux", arch: "x86_64" }),
    settings: () => ({
      host: "0.0.0.0",
      authMode: "none",
      remoteOnly: false,
      verifyOnEnroll: false,
      approveRequiresExplicitGrant: false,
      signalRequiresExplicitGrant: false,
      tagRequiresExplicitGrant: false,
      grantReload: "watch",
      hotReload: false,
      reusePort: false,
      schedule: true,
      dashboard: false,
      autoResume: true,
    }),
    serveYamlVersion: () => 1,
    federationRole: () => "none",
    datastore: () =>
      Promise.resolve({
        customType: undefined,
        format: "v2",
        hasControlPlane: false,
      }),
    vaultTypes: () => Promise.resolve([]),
    extensions: () => Promise.resolve([]),
    queryData: () => Promise.resolve(records),
  };
}

Deno.test("serveFingerprint: counts every worker record whatever its status", async () => {
  const events = await collect(
    serveFingerprint(
      createLibSwampContext(),
      deps([
        worker("idle", "v1", { region: "eu" }),
        worker("disconnected", "v1", { region: "us", pool: "gpu" }),
        { attributes: { not: "a worker" } } as unknown as DataRecord,
      ]),
    ),
  );
  assertEquals(events.map((e) => e.kind), ["resolving", "completed"]);
  const completed = events[1];
  if (completed.kind !== "completed") throw new Error("expected completed");
  assertEquals(completed.data.fingerprint.workers, {
    total: 2,
    byVersion: { v1: 2 },
    byLabelKey: { region: 2, pool: 1 },
  });
  assertEquals(JSON.stringify(completed.data).includes("gpu"), false);
  assertEquals(/^[0-9a-f]{64}$/.test(completed.data.hash), true);
});

Deno.test("serveFingerprint: a failing port is an error event", async () => {
  const events = await collect(
    serveFingerprint(createLibSwampContext(), {
      ...deps([]),
      datastore: () => Promise.reject(new Error("provider failed")),
    }),
  );
  assertEquals(events.map((e) => e.kind), ["resolving", "error"]);
  const error = events[1];
  if (error.kind !== "error") throw new Error("expected error");
  assertEquals(error.error.code, "serve_fingerprint_failed");
  assertEquals(error.error.message, "provider failed");
});
