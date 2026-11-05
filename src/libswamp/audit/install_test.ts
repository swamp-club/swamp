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

import { assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  auditInstall,
  auditUninstall,
  type AuditUserHookDeps,
} from "./install.ts";

function fakeDeps(overrides: Partial<AuditUserHookDeps> = {}): {
  deps: AuditUserHookDeps;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      homeDir: () => "/home/u",
      install: (home) => {
        calls.push(`install ${home}`);
        return Promise.resolve({
          settingsPath: `${home}/.claude/settings.json`,
          changed: true,
        });
      },
      remove: (home) => {
        calls.push(`remove ${home}`);
        return Promise.resolve({
          settingsPath: `${home}/.claude/settings.json`,
          changed: false,
        });
      },
      ...overrides,
    },
  };
}

Deno.test("auditInstall: installs into the home dir and reports the file", async () => {
  const { deps, calls } = fakeDeps();
  const events = await collect(auditInstall(createLibSwampContext(), deps));
  assertEquals(calls, ["install /home/u"]);
  assertEquals(events, [{
    kind: "completed",
    data: {
      action: "install",
      scope: "user",
      tool: "claude",
      settingsPath: "/home/u/.claude/settings.json",
      changed: true,
    },
  }]);
});

Deno.test("auditUninstall: removes from the home dir and reports no change", async () => {
  const { deps, calls } = fakeDeps();
  const events = await collect(auditUninstall(createLibSwampContext(), deps));
  assertEquals(calls, ["remove /home/u"]);
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  if (events[0].kind === "completed") {
    assertEquals(events[0].data.action, "uninstall");
    assertEquals(events[0].data.changed, false);
  }
});

Deno.test("auditInstall: a refused settings file becomes an error event", async () => {
  const { deps } = fakeDeps({
    install: () => Promise.reject(new UserError("not valid JSON")),
  });
  const events = await collect(auditInstall(createLibSwampContext(), deps));
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertEquals(events[0].error.code, "user_error");
    assertEquals(events[0].error.message, "not valid JSON");
  }
});

Deno.test("auditInstall: an unexpected failure propagates", async () => {
  const { deps } = fakeDeps({
    install: () => Promise.reject(new Deno.errors.PermissionDenied("denied")),
  });
  await assertRejects(
    () => collect(auditInstall(createLibSwampContext(), deps)),
    Deno.errors.PermissionDenied,
  );
});
