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
import fc from "fast-check";
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

const CONTRACT = new Set(Object.keys(sampleProps()));

function shuffleKeys<T extends object>(value: T, seed: number): T {
  const entries = Object.entries(value);
  entries.sort((a, b) =>
    ((a[0].charCodeAt(0) * seed) % 97) - ((b[0].charCodeAt(0) * seed) % 97)
  );
  return Object.fromEntries(entries) as T;
}

Deno.test("Fingerprint property: round-trips and hashes the same whatever the key and list order", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string(), { maxLength: 5 }),
      fc.uniqueArray(
        fc.record({ name: fc.string(), version: fc.string() }),
        { selector: (e) => e.name, maxLength: 5 },
      ),
      fc.integer({ min: 1, max: 1000 }),
      (vaultKinds, extensions, seed) => {
        const props = { ...sampleProps(), vaultKinds, extensions };
        const a = Fingerprint.create(props);
        const b = Fingerprint.create(
          shuffleKeys({
            ...props,
            vaultKinds: [...vaultKinds].reverse(),
            extensions: [...extensions].reverse().map((e) =>
              shuffleKeys(e, seed)
            ),
          }, seed),
        );
        assertEquals(b.hash(), a.hash());
        assertEquals(Fingerprint.fromJSON(a.toJSON()).toJSON(), a.toJSON());
      },
    ),
  );
});

Deno.test("Fingerprint property: create refuses any field outside the contract", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }).filter((key) =>
        !CONTRACT.has(key) && key !== "__proto__"
      ),
      fc.jsonValue(),
      (key, value) => {
        assertThrows(() =>
          Fingerprint.create({ ...sampleProps(), [key]: value })
        );
      },
    ),
  );
});

Deno.test("Fingerprint property: hash never moves with workers or runtime fields", () => {
  const base = Fingerprint.create(sampleProps()).hash();
  const counts = fc.dictionary(fc.string(), fc.nat());
  fc.assert(
    fc.property(
      fc.record({ total: fc.nat(), byVersion: counts, byLabelKey: counts }),
      fc.option(
        fc.record({
          role: fc.constantFrom("leader", "follower", "peer", "single"),
          nodes: fc.integer({ min: 1, max: 64 }),
        }),
      ),
      fc.option(fc.date().map((d) => d.toISOString())),
      fc.option(fc.boolean()),
      (workers, team, startedAt, ready) => {
        const fingerprint = Fingerprint.create({
          ...sampleProps(),
          workers,
          team: team as never,
          startedAt,
          ready,
        });
        assertEquals(fingerprint.hash(), base);
      },
    ),
  );
});

Deno.test("computeSettingsHash property: excluded settings never move the hash", () => {
  const base = computeSettingsHash(SETTINGS);
  fc.assert(
    fc.property(
      fc.record({
        admins: fc.string(),
        allowedUsers: fc.string(),
        allowedCollectives: fc.string(),
        oauthClientId: fc.string(),
        oauthProvider: fc.string(),
        webhook: fc.array(fc.string()),
        grantsFile: fc.string(),
        grantsDir: fc.string(),
        host: fc.string(),
        port: fc.nat(),
        keyFile: fc.string(),
        caCert: fc.string(),
        address: fc.string(),
      }),
      (excluded) => {
        assertEquals(computeSettingsHash({ ...SETTINGS, ...excluded }), base);
      },
    ),
  );
});

const extraKey = fc.string({ minLength: 1, maxLength: 12 }).filter((key) =>
  !(key in sampleProps())
);

Deno.test("Fingerprint: extra keys never change the contract fields or the hash, and a record keeps them", () => {
  fc.assert(
    fc.property(
      fc.dictionary(extraKey, fc.jsonValue(), { maxKeys: 5 }),
      (extras) => {
        const props = sampleProps();
        const input = { ...props, ...extras };
        const plain = Fingerprint.create(props);
        const wire = Fingerprint.fromWire(input);
        const record = Fingerprint.fromRecord(input);
        assertEquals(wire.toJSON(), plain.toJSON());
        assertEquals(record.fields(), plain.toJSON());
        assertEquals(record.hash(), plain.hash());
        assertEquals(wire.hash(), plain.hash());
        const kept = record.toJSON() as unknown as Record<string, unknown>;
        for (const key of Object.keys(extras)) {
          if (key === "__proto__") continue;
          assertEquals(
            JSON.stringify(kept[key]),
            JSON.stringify(input[key as keyof typeof input]),
          );
        }
      },
    ),
  );
});
