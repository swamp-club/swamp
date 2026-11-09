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

import { assert, assertEquals } from "@std/assert";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  checkDelegationCapability,
  DELEGATION_LINKS_CAPABILITY,
} from "./delegation_capability_check.ts";
import { SERVE_INSTANCE_CAPABILITIES } from "./instance_heartbeat.ts";

function storeOf(records: Record<string, unknown>): ControlPlaneStore {
  const encoded = new Map(
    Object.entries(records).map((
      [id, value],
    ) => [
      `heartbeats/${id}`,
      new TextEncoder().encode(
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    ]),
  );
  return {
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    get: (key: string) => Promise.resolve(encoded.get(key) ?? null),
    list: (prefix: string) =>
      Promise.resolve([...encoded.keys()].filter((k) => k.startsWith(prefix))),
  };
}

function heartbeat(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instanceId: id,
    hostname: `host-${id}`,
    pid: 1,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    capabilities: [DELEGATION_LINKS_CAPABILITY],
    ...overrides,
  };
}

Deno.test("checkDelegationCapability: no control plane means only this node, which passes", async () => {
  assertEquals(await checkDelegationCapability(undefined), { ok: true });
  assertEquals(await checkDelegationCapability(storeOf({})), { ok: true });
});

Deno.test("checkDelegationCapability: passes when every live node has the capability", async () => {
  const result = await checkDelegationCapability(
    storeOf({ a: heartbeat("a"), b: heartbeat("b") }),
  );
  assertEquals(result, { ok: true });
});

Deno.test("checkDelegationCapability: a live node that still rotates refresh tokens refuses and is named", async () => {
  const rotating = heartbeat("rot", { capabilities: ["delegation-links-1"] });
  const result = await checkDelegationCapability(
    storeOf({ a: heartbeat("a"), rot: rotating }),
  );
  assertEquals(result, { ok: false, instances: ["rot (host-rot)"] });
});

Deno.test("SERVE_INSTANCE_CAPABILITIES: this build advertises the capability it requires", () => {
  assert(SERVE_INSTANCE_CAPABILITIES.includes(DELEGATION_LINKS_CAPABILITY));
});

Deno.test("checkDelegationCapability: a live node from an older build refuses and is named", async () => {
  const older = heartbeat("old");
  delete older.capabilities;
  const result = await checkDelegationCapability(
    storeOf({ a: heartbeat("a"), old: older }),
  );
  assertEquals(result, { ok: false, instances: ["old (host-old)"] });
});

Deno.test("checkDelegationCapability: stale and stopped heartbeats are not live", async () => {
  const stale = heartbeat("stale", {
    heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  delete stale.capabilities;
  const stopped = heartbeat("stopped", {
    stoppedAt: new Date().toISOString(),
  });
  delete stopped.capabilities;
  const result = await checkDelegationCapability(
    storeOf({ a: heartbeat("a"), stale, stopped }),
  );
  assertEquals(result, { ok: true });
});

Deno.test("checkDelegationCapability: a record's own stale window is honoured", async () => {
  const slow = heartbeat("slow", {
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    staleTtlMs: 600_000,
  });
  delete slow.capabilities;
  const result = await checkDelegationCapability(storeOf({ slow }));
  assertEquals(result.ok, false);
});

Deno.test("checkDelegationCapability: a record this build can't read counts against", async () => {
  const result = await checkDelegationCapability(
    storeOf({ a: heartbeat("a"), odd: "{not json" }),
  );
  assertEquals(result, { ok: false, instances: ["odd"] });
});
