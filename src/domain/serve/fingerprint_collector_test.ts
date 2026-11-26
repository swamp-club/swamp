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
  countWorkers,
  FingerprintCollector,
  type FingerprintCollectorPorts,
  isLoopbackHost,
} from "./fingerprint_collector.ts";
import { computeSettingsHash } from "./fingerprint.ts";

const SETTINGS = {
  host: "127.0.0.1",
  authMode: "token",
  certFile: "/etc/serve/cert.pem",
  remoteOnly: false,
  verifyOnEnroll: true,
  approveRequiresExplicitGrant: false,
  signalRequiresExplicitGrant: false,
  tagRequiresExplicitGrant: false,
  grantReload: "watch",
  hotReload: false,
  reusePort: false,
  schedule: true,
  dashboard: false,
  autoResume: true,
};

function ports(
  overrides: Partial<FingerprintCollectorPorts> = {},
): FingerprintCollectorPorts {
  return {
    buildVersion: () => "20261125.1629.0",
    platform: () => ({ platform: "linux", arch: "aarch64" }),
    settings: () => SETTINGS,
    serveYamlVersion: () => 2,
    federationRole: () => "hub",
    datastore: () =>
      Promise.resolve({
        customType: "@swamp/s3-datastore",
        format: "v3",
        hasControlPlane: true,
      }),
    vaultTypes: () => Promise.resolve(["local_encryption"]),
    extensions: () =>
      Promise.resolve([
        { name: "@b/two", version: "2.0.0" },
        { name: "@a/one", version: "1.0.0" },
      ]),
    workers: () =>
      Promise.resolve([
        { swampVersion: "v1", labelKeys: ["region", "pool"] },
        { swampVersion: "v1", labelKeys: ["region"] },
        { swampVersion: "v2", labelKeys: [] },
      ]),
    ...overrides,
  };
}

Deno.test("FingerprintCollector.collect: builds the contract from its ports", async () => {
  const fingerprint = await new FingerprintCollector(ports()).collect();
  assertEquals(fingerprint.toJSON(), {
    swampVersion: "20261125.1629.0",
    platform: "linux",
    arch: "aarch64",
    serveYamlVersion: 2,
    deploymentMode: "durable (limited)",
    datastoreKind: "@swamp/s3-datastore",
    datastoreFormat: "v3",
    vaultKinds: ["local_encryption"],
    authMode: "token",
    tls: true,
    remoteOnly: false,
    loopbackOnly: true,
    federationRole: "hub",
    extensions: [
      { name: "@a/one", version: "1.0.0" },
      { name: "@b/two", version: "2.0.0" },
    ],
    settingsHash: computeSettingsHash(SETTINGS),
    workers: {
      total: 3,
      byVersion: { v1: 2, v2: 1 },
      byLabelKey: { region: 2, pool: 1 },
    },
    team: null,
    startedAt: null,
    ready: null,
  });
});

Deno.test("FingerprintCollector.collect: the filesystem datastore is local", async () => {
  const fingerprint = await new FingerprintCollector(ports({
    datastore: () =>
      Promise.resolve({
        customType: undefined,
        format: "v2",
        hasControlPlane: false,
      }),
  })).collect();
  assertEquals(fingerprint.toJSON().datastoreKind, "filesystem");
  assertEquals(fingerprint.toJSON().deploymentMode, "local");
});

Deno.test("FingerprintCollector.collect: runtime facts are carried but not hashed", async () => {
  const collector = new FingerprintCollector(ports());
  const offline = await collector.collect();
  const running = await collector.collect({
    team: { role: "leader", nodes: 2 },
    startedAt: "2026-11-26T00:00:00.000Z",
    ready: true,
  });
  assertEquals(running.toJSON().team, { role: "leader", nodes: 2 });
  assertEquals(running.hash(), offline.hash());
});

Deno.test("FingerprintCollector.collect: a port failure propagates", async () => {
  await assertRejects(
    () =>
      new FingerprintCollector(ports({
        datastore: () => Promise.reject(new Error("cannot load provider")),
      })).collect(),
    Error,
    "cannot load provider",
  );
});

Deno.test("countWorkers: counts every record, by version and label key, never values", () => {
  assertEquals(countWorkers([]), { total: 0, byVersion: {}, byLabelKey: {} });
  assertEquals(
    countWorkers([{ swampVersion: "v1", labelKeys: ["a", "a"] }]),
    { total: 1, byVersion: { v1: 1 }, byLabelKey: { a: 1 } },
  );
});

Deno.test("isLoopbackHost: loopback names and addresses only", () => {
  for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
    assertEquals(isLoopbackHost(host), true, host);
  }
  for (
    const host of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1.example.com",
      "::",
      "127.0.0.256",
    ]
  ) {
    assertEquals(isLoopbackHost(host), false, host);
  }
});
