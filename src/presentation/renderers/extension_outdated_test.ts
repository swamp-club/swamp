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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionOutdatedRenderer } from "./extension_outdated.ts";

Deno.test("JsonExtensionOutdatedRenderer - emits extensions and hasUpdateAvailable", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionOutdatedRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: {
        extensions: [
          {
            status: "update_available",
            name: "@ns/foo",
            installedVersion: "2026.01.01.1",
            latestVersion: "2026.05.01.1",
          },
        ],
        hasUpdateAvailable: true,
        hasDeprecated: false,
      },
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.hasUpdateAvailable, true);
    assertEquals(parsed.hasDeprecated, false);
    assertEquals(parsed.extensions.length, 1);
    assertEquals(parsed.extensions[0].status, "update_available");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonExtensionOutdatedRenderer - empty extensions still emits structure", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionOutdatedRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: { extensions: [], hasUpdateAvailable: false, hasDeprecated: false },
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions, []);
    assertEquals(parsed.hasUpdateAvailable, false);
  } finally {
    console.log = originalLog;
  }
});

async function captureLog(fn: () => void | Promise<void>): Promise<string> {
  await initializeLogging({
    _reset: true,
    logLevel: "info",
    _logsConfig: { exporterKind: "none" },
  });
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn };
  const capture = (...args: unknown[]) => lines.push(args.join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  return lines.join("\n");
}

Deno.test("LogExtensionOutdatedRenderer - prints the installed and latest version without a prefix", async () => {
  const out = await captureLog(() =>
    createExtensionOutdatedRenderer("log").handlers().completed({
      kind: "completed",
      data: {
        extensions: [
          {
            status: "update_available",
            name: "@ns/foo",
            installedVersion: "2026.01.01.1",
            latestVersion: "2026.05.01.1",
          },
          {
            status: "not_found",
            name: "@ns/gone",
            installedVersion: "2026.03.01.1",
            error: "not in registry",
          },
          {
            status: "failed",
            name: "@ns/flaky",
            installedVersion: "2026.04.01.1",
            error: "timeout",
          },
          {
            status: "deprecated",
            name: "@ns/old",
            installedVersion: "2026.02.01.1",
            deprecationReason: null,
            supersededBy: "@ns/new",
          },
        ],
        hasUpdateAvailable: true,
        hasDeprecated: true,
      },
    })
  );
  assertStringIncludes(
    out,
    "@ns/foo    2026.01.01.1 -> 2026.05.01.1  (update available)",
  );
  assertStringIncludes(
    out,
    "@ns/old    2026.02.01.1  (deprecated — use @ns/new instead)",
  );
  assertStringIncludes(out, "@ns/gone   2026.03.01.1  (not found in registry)");
  assertStringIncludes(out, "@ns/flaky  2026.04.01.1  (check failed: timeout)");
});
