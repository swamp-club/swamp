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
import { redactServeOptions } from "../../../../src/serve/handlers/admin_handlers.ts";
import type { MergedServeOptions } from "../../../../src/serve/serve_config.ts";
import { serveConfigRows } from "./serve_config_rows.ts";

// Build the payload exactly as handleServeConfig sends it, so a change to the
// server's serve.config shape fails here rather than in the dashboard.
function serveConfigPayload(opts: Record<string, unknown>): unknown {
  return {
    config: redactServeOptions(opts as unknown as MergedServeOptions),
  };
}

const baseOptions = {
  port: 9090,
  host: "0.0.0.0",
  authMode: "token",
  grantReload: "manual",
  approveRequiresExplicitGrant: false,
  verifyOnEnroll: true,
  detachRuns: false,
  enableInternalApi: false,
};

Deno.test("serveConfigRows: renders a real serve.config payload with everything on", () => {
  const rows = serveConfigRows(serveConfigPayload({
    ...baseOptions,
    certFile: "/tls/tls.crt",
    keyFile: "/tls/tls.key",
    schedule: true,
    dashboard: true,
    remoteOnly: true,
    autoResume: true,
    hotReload: true,
    trustProxy: true,
    webhookConfigs: [{ route: "/hook", workflow: "deploy", secret: "s" }],
  }));

  assertEquals(rows, [
    { label: "Port", value: "9090", ok: false },
    { label: "TLS", value: "enabled", ok: true },
    { label: "Auth Mode", value: "token", ok: false },
    { label: "Scheduling", value: "enabled", ok: true },
    { label: "Dashboard", value: "enabled", ok: true },
    { label: "Remote Only", value: "enabled", ok: true },
    { label: "Auto Resume", value: "enabled", ok: true },
    { label: "Hot Reload", value: "enabled", ok: true },
    { label: "Trust Proxy", value: "enabled", ok: true },
    { label: "Webhooks", value: "1 endpoints", ok: false },
  ]);
});

Deno.test("serveConfigRows: renders disabled flags from a real serve.config payload", () => {
  const rows = serveConfigRows(serveConfigPayload({
    ...baseOptions,
    port: 8080,
    authMode: "none",
    schedule: false,
    dashboard: false,
    remoteOnly: false,
    autoResume: false,
    hotReload: false,
    trustProxy: false,
  }));

  assertEquals(rows, [
    { label: "Port", value: "8080", ok: false },
    { label: "TLS", value: "disabled", ok: false },
    { label: "Auth Mode", value: "none", ok: false },
    { label: "Scheduling", value: "disabled", ok: false },
    { label: "Dashboard", value: "disabled", ok: false },
    { label: "Remote Only", value: "disabled", ok: false },
    { label: "Auto Resume", value: "disabled", ok: false },
    { label: "Hot Reload", value: "disabled", ok: false },
    { label: "Trust Proxy", value: "disabled", ok: false },
  ]);
});

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
