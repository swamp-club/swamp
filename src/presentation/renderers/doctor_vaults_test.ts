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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DoctorVaultsData } from "../../libswamp/models/doctor_vaults.ts";
import { createDoctorVaultsRenderer } from "./doctor_vaults.ts";

await initializeLogging({});

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

const fallbackData: DoctorVaultsData = {
  scanned: 1,
  hasVault: true,
  findings: [],
  unresolved: [],
  fallbackWarning: {
    fallbackVault: "infra",
    userVaults: ["infra", "local-secrets"],
    definitions: [{
      definitionId: "def-1",
      definitionName: "pve-auth",
      type: "@keeb/proxmox/node",
    }],
  },
};

Deno.test("doctor_vaults log renderer: warns about the fallback vault and still passes", async () => {
  const r = createDoctorVaultsRenderer("log");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: fallbackData });
  });

  assertEquals(r.overallStatus, "pass");
  assertStringIncludes(
    out,
    "All behaviors with sensitive outputs have a vault configured",
  );
  assertStringIncludes(out, "are stored in 'infra'");
  assertStringIncludes(out, "infra, local-secrets");
  assertStringIncludes(out, "pve-auth");
  assertStringIncludes(out, "defaultVault: <vault>");
  assertStringIncludes(out, "(defaultVault is not set)");
  assertStringIncludes(out, "(1 definition(s) scanned, 1 warning)");
  assert(!out.includes("not a vault in this repository"));
});

Deno.test("doctor_vaults log renderer: names a defaultVault that is not registered", async () => {
  const r = createDoctorVaultsRenderer("log");
  const out = await captureStdout(() => {
    r.handlers().completed?.({
      kind: "completed",
      data: {
        ...fallbackData,
        fallbackWarning: {
          ...fallbackData.fallbackWarning!,
          unregisteredDefaultVault: "gone",
        },
      },
    });
  });

  assertStringIncludes(out, "names 'gone', which is not a vault");
  assert(!out.includes("defaultVault is not set"));
});

Deno.test("doctor_vaults log renderer: no fallback warning when none applies", async () => {
  const r = createDoctorVaultsRenderer("log");
  const out = await captureStdout(() => {
    r.handlers().completed?.({
      kind: "completed",
      data: { ...fallbackData, fallbackWarning: undefined },
    });
  });

  assertEquals(r.overallStatus, "pass");
  assert(!out.includes("are stored in"));
  assert(!out.includes("warning)"));
});

Deno.test("doctor_vaults json renderer: includes fallbackWarning only when it applies", async () => {
  const r = createDoctorVaultsRenderer("json");
  const out = await captureStdout(() => {
    r.handlers().completed?.({ kind: "completed", data: fallbackData });
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "pass");
  assertEquals(parsed.fallbackWarning, fallbackData.fallbackWarning);

  const r2 = createDoctorVaultsRenderer("json");
  const out2 = await captureStdout(() => {
    r2.handlers().completed?.({
      kind: "completed",
      data: { ...fallbackData, fallbackWarning: undefined },
    });
  });
  assertEquals("fallbackWarning" in JSON.parse(out2), false);
});
