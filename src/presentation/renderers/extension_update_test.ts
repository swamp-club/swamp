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
import type { ExtensionUpdateResult } from "../../domain/extensions/extension_update_service.ts";
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
    summary: {
      total: 0,
      upToDate: 0,
      updated: 0,
      failed: 0,
      keptWithCollision: 0,
    },
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

Deno.test("extension_update log renderer: an update kept despite a type collision says so, not failed (swamp-club#2724)", async () => {
  const out = await captureConsole(async () => {
    const handlers = createExtensionUpdateRenderer("log").handlers();
    await handlers.completed({
      kind: "completed",
      data: {
        extensions: [{
          status: "kept_with_collision",
          name: "@ns/a",
          previousVersion: "2026.01.01.1",
          newVersion: "2026.03.01.1",
          error: "the install was kept",
        }],
        summary: {
          total: 1,
          upToDate: 0,
          updated: 0,
          failed: 0,
          keptWithCollision: 1,
        },
      },
      mode: "update",
    });
  });

  assertStringIncludes(
    out,
    "@ns/a: kept 2026.03.01.1 (was 2026.01.01.1) despite a type collision",
  );
  assertStringIncludes(
    out,
    "1 extension(s): 0 updated, 0 up to date, 0 failed, 1 kept with a type collision",
  );
});

Deno.test("extension_update log renderer: check rows and result lines print versions without a prefix", async () => {
  const check = await captureConsole(async () => {
    await createExtensionUpdateRenderer("log").handlers().completed({
      kind: "completed",
      data: {
        ...emptyResult(),
        extensions: [
          {
            status: "update_available",
            name: "@ns/a",
            installedVersion: "2026.01.01.1",
            latestVersion: "2026.03.01.1",
          },
          {
            status: "up_to_date",
            name: "@ns/b",
            installedVersion: "2026.02.01.1",
            latestVersion: "2026.02.01.1",
          },
          {
            status: "not_found",
            name: "@ns/c",
            installedVersion: "2026.04.01.1",
            error: "not in registry",
          },
          {
            status: "failed",
            name: "@ns/d",
            installedVersion: "2026.05.01.1",
            error: "timeout",
          },
          {
            status: "deprecated",
            name: "@ns/e",
            installedVersion: "2026.06.01.1",
            deprecationReason: null,
            supersededBy: null,
          },
        ],
      },
      mode: "check",
    });
  });
  assertStringIncludes(
    check,
    "@ns/a  2026.01.01.1 -> 2026.03.01.1  (update available)",
  );
  assertStringIncludes(check, "@ns/b  2026.02.01.1  (up to date)");
  assertStringIncludes(check, "@ns/c  2026.04.01.1  (not found in registry)");
  assertStringIncludes(check, "@ns/d  2026.05.01.1  (update failed: timeout)");
  assertStringIncludes(check, "@ns/e  2026.06.01.1  (deprecated)");

  const update = await captureConsole(async () => {
    await createExtensionUpdateRenderer("log").handlers().completed({
      kind: "completed",
      data: {
        ...emptyResult(),
        extensions: [
          {
            status: "updated",
            name: "@ns/a",
            previousVersion: "2026.01.01.1",
            newVersion: "2026.03.01.1",
          },
          {
            status: "up_to_date",
            name: "@ns/b",
            installedVersion: "2026.02.01.1",
            latestVersion: "2026.02.01.1",
          },
        ],
      },
      mode: "update",
    });
  });
  assertStringIncludes(update, "Updated @ns/a: 2026.01.01.1 -> 2026.03.01.1");
  assertStringIncludes(update, "@ns/b: already up to date (2026.02.01.1)");
});

Deno.test("extension_update log renderer: progress lines print the quoted version without a prefix", async () => {
  const out = await captureConsole(async () => {
    const handlers = createExtensionUpdateRenderer("log").handlers();
    await handlers.updating({
      kind: "updating",
      name: "@ns/a",
      from: "2026.01.01.1",
      to: "2026.03.01.1",
    });
    await handlers["orphans-pruned"]({
      kind: "orphans-pruned",
      name: "@ns/a",
      from: "2026.01.01.1",
      to: "2026.03.01.1",
      paths: ["models/gone.ts"],
    });
  });
  assertStringIncludes(
    out,
    'Updating "@ns/a": "2026.01.01.1" -> "2026.03.01.1"',
  );
  assertStringIncludes(
    out,
    'Removed 1 file(s) no longer in "@ns/a" ("2026.01.01.1" -> "2026.03.01.1"):',
  );
});
