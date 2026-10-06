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
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  ControlPlaneDashboardSessionStore,
  DashboardSessionCapacityError,
} from "./dashboard_session_store.ts";

function createStore(): ControlPlaneStore {
  const records = new Map<string, Uint8Array>();
  return {
    put: (key, data) => {
      records.set(key, data);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(records.get(key) ?? null),
    delete: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)),
      ),
  };
}

const IDENTITY = {
  tokenName: "operator",
  tokenCreatedAt: "2026-10-06T00:00:00.000Z",
};

Deno.test("ControlPlaneDashboardSessionStore: resolves sessions across replica stores", async () => {
  const controlPlane = createStore();
  const firstReplica = new ControlPlaneDashboardSessionStore(controlPlane);
  const secondReplica = new ControlPlaneDashboardSessionStore(controlPlane);

  const created = await firstReplica.create(IDENTITY, "https://serve.test");
  assertEquals(await secondReplica.get(created.id), created);
});

Deno.test("ControlPlaneDashboardSessionStore: removes expired sessions before enforcing capacity", async () => {
  let now = Date.parse("2026-10-06T00:00:00.000Z");
  const store = new ControlPlaneDashboardSessionStore(createStore(), {
    now: () => now,
    ttlMs: 10,
    capacity: 1,
  });
  const expired = await store.create(IDENTITY, "https://serve.test");
  now += 11;

  const replacement = await store.create(IDENTITY, "https://serve.test");
  assertEquals(await store.get(expired.id), null);
  assertEquals(await store.get(replacement.id), replacement);
});

Deno.test("ControlPlaneDashboardSessionStore: refuses new active sessions at capacity", async () => {
  const store = new ControlPlaneDashboardSessionStore(createStore(), {
    capacity: 1,
  });
  await store.create(IDENTITY, "https://serve.test");

  await assertRejects(
    () => store.create(IDENTITY, "https://serve.test"),
    DashboardSessionCapacityError,
  );
});

Deno.test("ControlPlaneDashboardSessionStore: ignores malformed cookie identifiers", async () => {
  const store = new ControlPlaneDashboardSessionStore(createStore());
  assertEquals(await store.get("../../control-plane"), null);
});
