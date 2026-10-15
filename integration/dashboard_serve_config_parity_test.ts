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

/**
 * The dashboard's System tab renders the serve.config payload that serve's
 * admin handler sends (swamp-club#2519). Build that payload with the real
 * redactServeOptions so a change to its shape fails here rather than in the
 * dashboard. These cases live here, not next to serve_config_rows.ts, because
 * the dashboard is type-checked with DOM libs that serve's code does not
 * compile under.
 */

import { assertEquals } from "@std/assert";
import { redactServeOptions } from "../src/serve/handlers/admin_handlers.ts";
import type { MergedServeOptions } from "../src/serve/serve_config.ts";
import { serveConfigRows } from "../packages/dashboard/src/views/serve_config_rows.ts";

// Build the payload exactly as handleServeConfig sends it.
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
    { label: "Webhooks", value: "1 endpoint", ok: false },
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
