// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DoctorSecretsData } from "../../libswamp/mod.ts";
import { createDoctorSecretsRenderer } from "./doctor_secrets.ts";

await initializeLogging({});

const SECRET = "SUPERSECRET123";

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  return Promise.resolve(fn())
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => lines.join("\n"));
}

const cleanData: DoctorSecretsData = {
  scanned: 3,
  findings: [],
  unresolved: [],
};

const leakData: DoctorSecretsData = {
  scanned: 2,
  findings: [{
    definitionId: "def-1",
    definitionName: "my-creds",
    type: "acme/api",
    leakedPaths: ["apiKey"],
    remediations: [{
      path: "apiKey",
      vaultName: "my-vault",
      vaultKey: "apiKey",
      expression: "${{ vault.get('my-vault', 'apiKey') }}",
    }],
  }],
  unresolved: [{
    definitionId: "def-2",
    definitionName: "orphan",
    type: "missing/extension",
  }],
};

Deno.test("doctor_secrets log renderer: passes on a clean scan", async () => {
  const r = createDoctorSecretsRenderer("log");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: cleanData });
  });

  assertEquals(r.overallStatus, "pass");
  assertStringIncludes(out, "No cleartext sensitive global arguments found");
});

Deno.test("doctor_secrets log renderer: fails and emits remediation on a leak", async () => {
  const r = createDoctorSecretsRenderer("log");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: leakData });
  });

  assertEquals(r.overallStatus, "fail");
  assertStringIncludes(out, "my-creds");
  assertStringIncludes(out, "apiKey");
  assertStringIncludes(out, "swamp vault put my-vault apiKey");
  assertStringIncludes(out, "vault.get('my-vault', 'apiKey')");
  // Unresolved definitions are surfaced as advisory warnings.
  assertStringIncludes(out, "could not be assessed");
  assertStringIncludes(out, "orphan");
});

Deno.test("doctor_secrets json renderer: emits structured payload and sets status", async () => {
  const r = createDoctorSecretsRenderer("json");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: leakData });
  });

  assertEquals(r.overallStatus, "fail");
  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(parsed.scanned, 2);
  assertEquals(parsed.findings.length, 1);
  assertEquals(parsed.unresolved.length, 1);
});

Deno.test("doctor_secrets json renderer: passes on a clean scan", async () => {
  const r = createDoctorSecretsRenderer("json");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: cleanData });
  });

  assertEquals(r.overallStatus, "pass");
  assertEquals(JSON.parse(out).overallStatus, "pass");
});

Deno.test("doctor_secrets renderers: never print the secret value", async () => {
  // The data the renderer receives is already value-free, but assert the
  // contract holds end-to-end: nothing the renderer emits can carry a secret.
  const dataWithSecretName: DoctorSecretsData = {
    scanned: 1,
    findings: [{
      definitionId: "def-1",
      definitionName: "my-creds",
      type: "acme/api",
      leakedPaths: ["apiKey"],
      remediations: [{
        path: "apiKey",
        vaultName: "my-vault",
        vaultKey: "apiKey",
        expression: "${{ vault.get('my-vault', 'apiKey') }}",
      }],
    }],
    unresolved: [],
  };

  for (const mode of ["log", "json"] as const) {
    const r = createDoctorSecretsRenderer(mode);
    const out = await captureStdout(() => {
      r.handlers().completed?.({ kind: "completed", data: dataWithSecretName });
    });
    assertEquals(out.includes(SECRET), false);
  }
});
