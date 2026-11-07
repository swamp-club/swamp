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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type { AuditUserHookDeps } from "../../libswamp/audit/install.ts";
import { requireUserScope, runAuditUserHook } from "./audit_install.ts";

await initializeLogging({});

function deps(calls: string[]): AuditUserHookDeps {
  const result = (home: string) =>
    Promise.resolve({
      settingsPath: `${home}/settings.json`,
      changed: true,
    });
  return {
    claudeDir: () => "/home/u/.claude",
    install: (home) => {
      calls.push("install");
      return result(home);
    },
    remove: (home) => {
      calls.push("remove");
      return result(home);
    },
  };
}

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

Deno.test("requireUserScope: refuses without --user and points at repo upgrade", () => {
  const error = assertThrows(
    () => requireUserScope("install", undefined),
    UserError,
    "needs --user",
  );
  assertEquals(error.message.includes("swamp repo upgrade"), true);
  requireUserScope("install", true);
});

Deno.test("runAuditUserHook: install without --user touches nothing", async () => {
  const calls: string[] = [];
  await assertRejects(
    () => runAuditUserHook("install", { json: true }, deps(calls)),
    UserError,
  );
  assertEquals(calls, []);
});

Deno.test("runAuditUserHook: install --user --json prints the result", async () => {
  const calls: string[] = [];
  const out = await captureLog(() =>
    runAuditUserHook("install", { json: true, user: true }, deps(calls))
  );
  assertEquals(calls, ["install"]);
  assertEquals(JSON.parse(out), {
    action: "install",
    scope: "user",
    tool: "claude",
    settingsPath: "/home/u/.claude/settings.json",
    changed: true,
  });
});

Deno.test("runAuditUserHook: uninstall --user removes", async () => {
  const calls: string[] = [];
  const out = await captureLog(() =>
    runAuditUserHook("uninstall", { json: true, user: true }, deps(calls))
  );
  assertEquals(calls, ["remove"]);
  assertEquals(JSON.parse(out).action, "uninstall");
});
