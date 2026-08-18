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
import {
  DEFAULT_STALE_TTL_MS,
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "../instance_heartbeat.ts";

Deno.test("InstanceHeartbeatService.parseRecord: parses valid record with address", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:01:00.000Z",
    address: "http://host-a:9090",
  };
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertEquals(parsed?.instanceId, "inst-1");
  assertEquals(parsed?.address, "http://host-a:9090");
});

Deno.test("InstanceHeartbeatService.parseRecord: parses record without address", () => {
  const record = {
    instanceId: "inst-2",
    hostname: "host-b",
    pid: 5678,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:01:00.000Z",
  };
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertEquals(parsed?.instanceId, "inst-2");
  assertEquals(parsed?.address, undefined);
});

Deno.test("InstanceHeartbeatService.isStale: healthy heartbeat is not stale", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: new Date().toISOString(),
  };
  assertEquals(InstanceHeartbeatService.isStale(record), false);
});

Deno.test("InstanceHeartbeatService.isStale: old heartbeat is stale", () => {
  const oldTime = new Date(Date.now() - DEFAULT_STALE_TTL_MS - 1000)
    .toISOString();
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: oldTime,
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("InstanceHeartbeatService.isStale: invalid timestamp is stale", () => {
  const record: HeartbeatRecord = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "not-a-date",
  };
  assertEquals(InstanceHeartbeatService.isStale(record), true);
});

Deno.test("redactServeOptions: verifies webhook secrets are not exposed", async () => {
  const { redactServeOptions } = await import("./admin_handlers.ts");
  const opts = {
    port: 9090,
    host: "127.0.0.1",
    schedule: true,
    authMode: "none",
    grantReload: "manual",
    trustProxy: false,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
    webhookConfigs: [{
      route: "/hook",
      workflow: "deploy",
      secret: "super-secret-value",
      scheme: "github",
    }],
  };
  const redacted = redactServeOptions(
    opts as unknown as import("../serve_config.ts").MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 1);
  assertEquals(webhooks[0].route, "/hook");
  assertEquals(webhooks[0].workflow, "deploy");
  assertEquals(webhooks[0].scheme, "github");
  assertEquals(Object.hasOwn(webhooks[0], "secret"), false);
});

Deno.test("redactServeOptions: omits TLS key file", async () => {
  const { redactServeOptions } = await import("./admin_handlers.ts");
  const opts = {
    port: 443,
    host: "0.0.0.0",
    schedule: false,
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
    authMode: "admin-token",
    grantReload: "manual",
    trustProxy: true,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
  };
  const redacted = redactServeOptions(
    opts as unknown as import("../serve_config.ts").MergedServeOptions,
  );
  const tls = redacted.tls as Record<string, unknown>;
  assertEquals(tls.enabled, true);
  assertEquals(tls.certFile, "/path/to/cert.pem");
  assertEquals(Object.hasOwn(tls, "keyFile"), false);
});

Deno.test("redactServeOptions: handles no webhooks", async () => {
  const { redactServeOptions } = await import("./admin_handlers.ts");
  const opts = {
    port: 9090,
    host: "127.0.0.1",
    schedule: true,
    authMode: "none",
    grantReload: "manual",
    trustProxy: false,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
  };
  const redacted = redactServeOptions(
    opts as unknown as import("../serve_config.ts").MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 0);
  assertEquals(redacted.port, 9090);
  assertEquals(redacted.authMode, "none");
});
