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
import { createExtensionRmRenderer } from "./extension_rm.ts";
import type { ExtensionRmData } from "../../libswamp/mod.ts";

await initializeLogging({});

/** Captures everything written through console.log/info/warn. */
function captureConsole(fn: () => void): string {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  return lines.join("\n");
}

const REMOVED: ExtensionRmData = {
  name: "@test/ext",
  version: "1.0.0",
  filesDeleted: 2,
  filesSkipped: 0,
  dirsRemoved: 1,
  failedFiles: [],
};

const WITH_FAILURES: ExtensionRmData = {
  ...REMOVED,
  filesDeleted: 1,
  failedFiles: [
    {
      path: ".swamp/pulled-extensions/@test/ext/models/locked.ts",
      reason: "PermissionDenied",
    },
  ],
};

Deno.test("createExtensionRmRenderer: log mode lists files it could not delete", () => {
  const handlers = createExtensionRmRenderer("log").handlers();
  const out = captureConsole(() => {
    handlers.completed({ kind: "completed", data: WITH_FAILURES });
  });
  assertStringIncludes(out, "Could not delete 1 file(s)");
  assertStringIncludes(
    out,
    ".swamp/pulled-extensions/@test/ext/models/locked.ts",
  );
  assertStringIncludes(out, "PermissionDenied");
});

Deno.test("createExtensionRmRenderer: log mode prints no failure warning when every file was deleted", () => {
  const handlers = createExtensionRmRenderer("log").handlers();
  const out = captureConsole(() => {
    handlers.completed({ kind: "completed", data: REMOVED });
  });
  assert(!out.includes("Could not delete"));
});

Deno.test("createExtensionRmRenderer: log mode tolerates a server that omits failedFiles", () => {
  const { failedFiles: _omitted, ...fromOlderServer } = REMOVED;
  const handlers = createExtensionRmRenderer("log").handlers();
  const out = captureConsole(() => {
    handlers.completed({ kind: "completed", data: fromOlderServer });
  });
  assert(!out.includes("Could not delete"));
});

Deno.test("createExtensionRmRenderer: json mode includes failedFiles", () => {
  const handlers = createExtensionRmRenderer("json").handlers();
  const out = captureConsole(() => {
    handlers.completed({ kind: "completed", data: WITH_FAILURES });
  });
  const parsed = JSON.parse(out);
  assertEquals(parsed.removed.failedFiles, WITH_FAILURES.failedFiles);
  assertEquals(parsed.removed.filesDeleted, 1);
});
