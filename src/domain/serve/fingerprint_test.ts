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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  computeSettingsHash,
  Fingerprint,
  type FingerprintProps,
  type FingerprintSettingsSource,
} from "./fingerprint.ts";

const SETTINGS: FingerprintSettingsSource = {
  authMode: "token",
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

function sampleProps(): FingerprintProps {
  return {
    swampVersion: "20261125.1629.0",
    platform: "linux",
    arch: "x86_64",
    serveYamlVersion: 2,
    deploymentMode: "durable",
    datastoreKind: "@swamp/s3-datastore",
    datastoreFormat: "v3",
    vaultKinds: ["@swamp/aws-sm-vault"],
    authMode: "token",
    tls: true,
    remoteOnly: false,
    loopbackOnly: false,
    federationRole: "none",
    extensions: [{ name: "@acme/tools", version: "1.2.0" }],
    settingsHash: computeSettingsHash(SETTINGS),
    workers: { total: 2, byVersion: { "20261125.1629.0": 2 }, byLabelKey: {} },
    team: null,
    startedAt: null,
    ready: null,
  };
}

Deno.test("Fingerprint.create: accepts the contract and round-trips through JSON", () => {
  const fingerprint = Fingerprint.create(sampleProps());
  const again = Fingerprint.fromJSON(
    JSON.parse(JSON.stringify(fingerprint.toJSON())),
  );
  assertEquals(again.toJSON(), fingerprint.toJSON());
  assertEquals(again.hash(), fingerprint.hash());
  assertEquals(again.equals(fingerprint), true);
});

Deno.test("Fingerprint.create: refuses a field outside the contract", () => {
  assertThrows(() => Fingerprint.create({ ...sampleProps(), hostname: "h" }));
  assertThrows(() =>
    Fingerprint.create({
      ...sampleProps(),
      workers: { ...sampleProps().workers, byLabelValue: {} },
    })
  );
  assertThrows(() =>
    Fingerprint.create({
      ...sampleProps(),
      extensions: [{ name: "a", version: "1", path: "/x" }],
    })
  );
});

Deno.test("Fingerprint.create: refuses a missing field", () => {
  const { settingsHash: _, ...rest } = sampleProps();
  assertThrows(() => Fingerprint.create(rest));
});

Deno.test("Fingerprint.hash: sha256 hex of the static fields", () => {
  const hash = Fingerprint.create(sampleProps()).hash();
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

Deno.test("Fingerprint.hash: unchanged by workers and runtime fields", () => {
  const base = Fingerprint.create(sampleProps()).hash();
  const changed = Fingerprint.create({
    ...sampleProps(),
    workers: { total: 9, byVersion: { x: 9 }, byLabelKey: { region: 9 } },
    team: { role: "leader", nodes: 3 },
    startedAt: "2026-11-26T00:00:00.000Z",
    ready: true,
  }).hash();
  assertEquals(changed, base);
});

Deno.test("Fingerprint.hash: changes when a static field changes", () => {
  const base = Fingerprint.create(sampleProps()).hash();
  assertNotEquals(
    Fingerprint.create({ ...sampleProps(), tls: false }).hash(),
    base,
  );
});

Deno.test("Fingerprint.staticFields: leaves out pool and runtime fields", () => {
  const fields = Fingerprint.create(sampleProps()).staticFields();
  for (const key of ["workers", "team", "startedAt", "ready"]) {
    assertEquals(key in fields, false, key);
  }
});

Deno.test("computeSettingsHash: list settings are compared as sets of names", () => {
  assertEquals(
    computeSettingsHash({ ...SETTINGS, dispatchEnvAllow: "B, A" }),
    computeSettingsHash({ ...SETTINGS, dispatchEnvAllow: "A,B,A" }),
  );
  assertNotEquals(
    computeSettingsHash({ ...SETTINGS, dispatchEnvAllow: "A" }),
    computeSettingsHash(SETTINGS),
  );
});

Deno.test("computeSettingsHash: reserved-worker-labels joins the hash only when set, so a node missing it shows as drift", () => {
  assertEquals(
    computeSettingsHash({ ...SETTINGS, reservedWorkerLabels: "" }),
    computeSettingsHash(SETTINGS),
  );
  assertNotEquals(
    computeSettingsHash({ ...SETTINGS, reservedWorkerLabels: "fleet" }),
    computeSettingsHash(SETTINGS),
  );
  assertEquals(
    computeSettingsHash({ ...SETTINGS, reservedWorkerLabels: "region,fleet" }),
    computeSettingsHash({ ...SETTINGS, reservedWorkerLabels: "fleet, region" }),
  );
});

Deno.test("computeSettingsHash: TLS is on or off, never the certificate path", () => {
  assertEquals(
    computeSettingsHash({ ...SETTINGS, certFile: "/a/cert.pem" }),
    computeSettingsHash({ ...SETTINGS, certFile: "/b/other.pem" }),
  );
  assertNotEquals(
    computeSettingsHash({ ...SETTINGS, certFile: "/a/cert.pem" }),
    computeSettingsHash(SETTINGS),
  );
});
