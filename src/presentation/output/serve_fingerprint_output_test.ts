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
import { stripAnsiCode } from "@std/fmt/colors";
import { renderServeFingerprint } from "./serve_fingerprint_output.ts";
import type { ServeFingerprintData } from "../../libswamp/serve/fingerprint.ts";

function capture(run: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

const DATA: ServeFingerprintData = {
  hash: "a".repeat(64),
  fingerprint: {
    swampVersion: "20261125.1629.0",
    platform: "linux",
    arch: "x86_64",
    serveYamlVersion: 2,
    deploymentMode: "durable",
    datastoreKind: "@swamp/s3-datastore",
    datastoreFormat: "v3",
    vaultKinds: ["@swamp/aws-sm-vault"],
    authMode: "oauth",
    tls: true,
    remoteOnly: true,
    loopbackOnly: false,
    federationRole: "hub",
    extensions: [{ name: "@acme/tools", version: "1.2.0" }],
    settingsHash: "b".repeat(64),
    workers: { total: 3, byVersion: { v1: 3 }, byLabelKey: { region: 2 } },
    team: null,
    startedAt: null,
    ready: null,
  },
};

Deno.test("renderServeFingerprint: json mode is the fingerprint and hash, runtime fields null", () => {
  const parsed = JSON.parse(
    capture(() => renderServeFingerprint(DATA, "json")),
  );
  assertEquals(parsed, DATA);
  assertEquals(parsed.fingerprint.team, null);
  assertEquals(parsed.fingerprint.startedAt, null);
  assertEquals(parsed.fingerprint.ready, null);
});

Deno.test("renderServeFingerprint: log mode groups the fields and shows the hash", () => {
  const output = stripAnsiCode(
    capture(() => renderServeFingerprint(DATA, "log")),
  );
  assertStringIncludes(output, `Fingerprint: ${"a".repeat(64)}`);
  for (
    const text of [
      "Build:",
      "Deployment:",
      "Access:",
      "Extensions:",
      "Mode: durable",
      "Datastore: @swamp/s3-datastore (v3)",
      "Federation role: hub",
      "@acme/tools 1.2.0",
      "Workers: 3",
      "By label key: region (2)",
      "Pool: (not part of the fingerprint hash)",
      "Team: known only to a running serve",
      "Ready: known only to a running serve",
    ]
  ) {
    assertStringIncludes(output, text);
  }
});

Deno.test("renderServeFingerprint: log mode shows runtime facts when known", () => {
  const output = stripAnsiCode(capture(() =>
    renderServeFingerprint({
      ...DATA,
      fingerprint: {
        ...DATA.fingerprint,
        team: { role: "leader", nodes: 3 },
        startedAt: "2026-11-26T00:00:00.000Z",
        ready: true,
      },
    }, "log")
  ));
  assertStringIncludes(output, "Team: leader (3 nodes)");
  assertStringIncludes(output, "Ready: true");
});
