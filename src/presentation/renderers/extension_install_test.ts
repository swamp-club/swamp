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
import { createExtensionInstallRenderer } from "./extension_install.ts";
import type { ExtensionInstallData } from "../../libswamp/mod.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

const EMPTY_DATA: ExtensionInstallData = {
  entries: [],
  installed: 0,
  migrated: 0,
  upToDate: 0,
  failed: 0,
};

Deno.test("createExtensionInstallRenderer: json mode adds warning field when lockfile is empty", () => {
  const renderer = createExtensionInstallRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() => {
    handlers.completed({ kind: "completed", data: EMPTY_DATA });
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.entries, []);
  assertEquals(typeof parsed.warning, "string");
  assertStringIncludes(parsed.warning, "no entries");
});

Deno.test("createExtensionInstallRenderer: json mode omits warning field when lockfile has entries", () => {
  const renderer = createExtensionInstallRenderer("json");
  const handlers = renderer.handlers();
  const data: ExtensionInstallData = {
    entries: [{ name: "@test/ext", version: "1.0.0", status: "up_to_date" }],
    installed: 0,
    migrated: 0,
    upToDate: 1,
    failed: 0,
  };
  const out = captureStdout(() => {
    handlers.completed({ kind: "completed", data });
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.warning, undefined);
  assertEquals(parsed.upToDate, 1);
});
