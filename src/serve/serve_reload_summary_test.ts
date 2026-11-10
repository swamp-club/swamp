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

import { assertEquals } from "@std/assert";
import { summarizeServeReload } from "./serve_reload_summary.ts";

Deno.test("summarizeServeReload: applied settings are info, unapplied ones say why", () => {
  const summary = summarizeServeReload({
    success: true,
    reloadedCount: 0,
    auditSinks: 1,
    settings: {
      applied: ["dashboard", "max-concurrent-runs"],
      needsRestart: [{
        setting: "port",
        reason: "needs a new process: the listener is bound to it",
      }],
      overridden: [{
        setting: "queue-timeout",
        by: "SWAMP_QUEUE_TIMEOUT",
      }],
    },
    errors: [],
  });
  assertEquals(summary.info, [
    "Reloaded 0 extension type(s)",
    "Audit sinks in force: 1",
    "Applied: dashboard, max-concurrent-runs",
  ]);
  assertEquals(summary.warn, [
    "queue-timeout changed in serve.yaml but SWAMP_QUEUE_TIMEOUT keeps it pinned; change SWAMP_QUEUE_TIMEOUT and restart to change it",
    "port changed but needs a new process: the listener is bound to it",
  ]);
  assertEquals(summary.error, []);
});

Deno.test("summarizeServeReload: a failed reload reports only its errors", () => {
  const summary = summarizeServeReload({
    success: false,
    reloadedCount: 0,
    errors: ["Reload already in progress"],
  });
  assertEquals(summary, {
    info: [],
    warn: [],
    error: ["Reload already in progress"],
  });
});
