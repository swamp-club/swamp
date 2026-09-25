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

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { ExtensionUpdateResult } from "../../libswamp/mod.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionUpdateRenderer } from "./extension_update.ts";

await initializeLogging({});

async function captureConsole(
  fn: () => void | Promise<void>,
): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      );
    };
  }
  try {
    await fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function emptyResult(): ExtensionUpdateResult {
  return {
    extensions: [],
    summary: { total: 0, upToDate: 0, updated: 0, failed: 0 },
  };
}

Deno.test("extension_update json renderer: marks a check that read the fallback lockfile", async () => {
  const out = await captureConsole(async () => {
    const handlers = createExtensionUpdateRenderer("json").handlers();
    await handlers.completed({
      kind: "completed",
      data: emptyResult(),
      mode: "check",
      fallbackLockfile: true,
    });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.lockfileSource, "fallback");
  assertStringIncludes(parsed.warning, "swamp datastore sync --pull");
  assertEquals(parsed.extensions, []);
});

Deno.test("extension_update json renderer: output is unchanged when the datastore lockfile was read", async () => {
  const out = await captureConsole(async () => {
    const handlers = createExtensionUpdateRenderer("json").handlers();
    await handlers.completed({
      kind: "completed",
      data: emptyResult(),
      mode: "check",
    });
  });

  const parsed = JSON.parse(out);
  assertFalse("lockfileSource" in parsed);
  assertFalse("warning" in parsed);
});

Deno.test("extension_update log renderer: warns when the check read the fallback lockfile", async () => {
  const out = await captureConsole(async () => {
    const handlers = createExtensionUpdateRenderer("log").handlers();
    await handlers.completed({
      kind: "completed",
      data: emptyResult(),
      mode: "check",
      fallbackLockfile: true,
    });
  });

  assertStringIncludes(
    out,
    "this check reads the in-repo lockfile, not the datastore's",
  );
});
