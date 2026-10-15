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
import { serveConfigRows } from "./serve_config_rows.ts";

// The cases that render a real serve.config payload from serve's
// redactServeOptions live in integration/dashboard_serve_config_parity_test.ts.

Deno.test("serveConfigRows: returns null when there is no config to show", () => {
  assertEquals(serveConfigRows(null), null);
  assertEquals(serveConfigRows("serve.config"), null);
  assertEquals(serveConfigRows({}), null);
  assertEquals(serveConfigRows({ port: 9090, authMode: "token" }), null);
  assertEquals(serveConfigRows({ config: [] }), null);
});

Deno.test("serveConfigRows: shows a dash for a missing or misshapen field", () => {
  const rows = serveConfigRows({
    config: { port: 9090, scheduling: true, hotReload: "yes" },
  });

  assertEquals(rows, [
    { label: "Port", value: "9090", ok: false },
    { label: "TLS", value: "—", ok: false },
    { label: "Auth Mode", value: "—", ok: false },
    { label: "Scheduling", value: "—", ok: false },
    { label: "Dashboard", value: "—", ok: false },
    { label: "Remote Only", value: "—", ok: false },
    { label: "Auto Resume", value: "—", ok: false },
    { label: "Hot Reload", value: "—", ok: false },
    { label: "Trust Proxy", value: "—", ok: false },
  ]);
});
