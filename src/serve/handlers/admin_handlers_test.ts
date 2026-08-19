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
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { MergedServeOptions } from "../serve_config.ts";
import {
  collectClusterInstances,
  redactServeOptions,
} from "./admin_handlers.ts";

function makeHeartbeat(
  id: string,
  heartbeatAt: string,
  address?: string,
): HeartbeatRecord {
  return {
    instanceId: id,
    hostname: "test-host",
    pid: 1000,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt,
    ...(address !== undefined ? { address } : {}),
  };
}

function makeStore(
  records: HeartbeatRecord[],
): ControlPlaneStore {
  const store = new Map<string, Uint8Array>();
  for (const r of records) {
    store.set(
      `heartbeats/${r.instanceId}`,
      new TextEncoder().encode(JSON.stringify(r)),
    );
  }
  return {
    put(key: string, data: Uint8Array) {
      store.set(key, data);
      return Promise.resolve();
    },
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    },
    delete(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
    list(prefix: string) {
      return Promise.resolve(
        [...store.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

// ── parseRecord tests ────────────────────────────────────────────────

Deno.test("parseRecord: parses valid record with address", () => {
  const record = makeHeartbeat(
    "inst-1",
    "2026-01-01T00:01:00.000Z",
    "http://host-a:9090",
  );
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertEquals(parsed?.instanceId, "inst-1");
  assertEquals(parsed?.address, "http://host-a:9090");
});

Deno.test("parseRecord: rejects record with non-string address", () => {
  const raw = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:01:00.000Z",
    address: 12345,
  };
  const data = new TextEncoder().encode(JSON.stringify(raw));
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);
});

// ── collectClusterInstances tests ────────────────────────────────────

Deno.test("collectClusterInstances: healthy status for fresh heartbeat", async () => {
  const now = new Date().toISOString();
  const store = makeStore([makeHeartbeat("inst-1", now, "http://host:9090")]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "healthy");
  assertEquals(instances[0].address, "http://host:9090");
});

Deno.test("collectClusterInstances: degraded status near stale threshold", async () => {
  const staleTtlMs = 90_000;
  const degradedAge = staleTtlMs * 2 / 3 + 1000;
  const degradedTime = new Date(Date.now() - degradedAge).toISOString();
  const store = makeStore([makeHeartbeat("inst-1", degradedTime)]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    staleTtlMs,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "degraded");
});

Deno.test("collectClusterInstances: unreachable status past stale threshold", async () => {
  const staleTtlMs = 90_000;
  const staleTime = new Date(Date.now() - staleTtlMs - 5000).toISOString();
  const store = makeStore([makeHeartbeat("inst-1", staleTime)]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    staleTtlMs,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "unreachable");
});

Deno.test("collectClusterInstances: unreachable for invalid timestamp", async () => {
  const store = makeStore([makeHeartbeat("inst-1", "not-a-date")]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "unreachable");
});

Deno.test("collectClusterInstances: standalone fallback when no heartbeats", async () => {
  const store = makeStore([]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "local-id",
    serveOptions: {
      port: 9090,
      host: "127.0.0.1",
    } as MergedServeOptions,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].instanceId, "local-id");
  assertEquals(instances[0].status, "healthy");
  assertEquals(instances[0].address, "http://127.0.0.1:9090");
});

Deno.test("collectClusterInstances: standalone fallback derives https from TLS options", async () => {
  const store = makeStore([]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "local-id",
    serveOptions: {
      port: 443,
      host: "0.0.0.0",
      certFile: "/path/to/cert.pem",
      keyFile: "/path/to/key.pem",
    } as MergedServeOptions,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].address, "https://0.0.0.0:443");
});

Deno.test("collectClusterInstances: multiple instances with mixed status", async () => {
  const now = new Date();
  const healthy = makeHeartbeat("inst-1", now.toISOString(), "http://a:9090");
  const stale = makeHeartbeat(
    "inst-2",
    new Date(now.getTime() - DEFAULT_STALE_TTL_MS - 5000).toISOString(),
    "http://b:9090",
  );
  const store = makeStore([healthy, stale]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "inst-1",
    signal: ac.signal,
  });

  assertEquals(instances.length, 2);
  const inst1 = instances.find((i) => i.instanceId === "inst-1");
  const inst2 = instances.find((i) => i.instanceId === "inst-2");
  assertEquals(inst1?.status, "healthy");
  assertEquals(inst2?.status, "unreachable");
});

// ── redactServeOptions tests ─────────────────────────────────────────

Deno.test("redactServeOptions: verifies webhook secrets are not exposed", () => {
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
    opts as unknown as MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 1);
  assertEquals(webhooks[0].route, "/hook");
  assertEquals(webhooks[0].workflow, "deploy");
  assertEquals(webhooks[0].scheme, "github");
  assertEquals(Object.hasOwn(webhooks[0], "secret"), false);
});

Deno.test("redactServeOptions: omits TLS key file", () => {
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
    opts as unknown as MergedServeOptions,
  );
  const tls = redacted.tls as Record<string, unknown>;
  assertEquals(tls.enabled, true);
  assertEquals(tls.certFile, "/path/to/cert.pem");
  assertEquals(Object.hasOwn(tls, "keyFile"), false);
});

Deno.test("redactServeOptions: handles no webhooks", () => {
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
    opts as unknown as MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 0);
  assertEquals(redacted.port, 9090);
  assertEquals(redacted.authMode, "none");
});
