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
import { initializeLogging } from "../logging/logger.ts";
import type { AtomicControlPlaneStore } from "./control_plane_signal_wait_store.ts";
import {
  CHECKOUT_IMPORT_SENTINEL,
  importCheckoutControlPlane,
} from "./checkout_control_plane_import.ts";

await initializeLogging({});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) =>
  data === null ? null : new TextDecoder().decode(data);

function memoryStore(
  entries: Record<string, string> = {},
): AtomicControlPlaneStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>(
    Object.entries(entries).map(([key, value]) => [key, bytes(value)]),
  );
  return {
    data,
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    putIfAbsent: (key, value) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, value);
      return Promise.resolve(true);
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve([...data.keys()].filter((key) => key.startsWith(prefix))),
  };
}

Deno.test("importCheckoutControlPlane: moves lasting records and token secrets, not a process's", async () => {
  const checkout = memoryStore({
    "pending-runs/p1": "pending",
    "fire-records/w/2026-10-28T10-00-00Z": "fired",
    "dashboard-sessions/s1": "session",
    "schedule-pauses/nightly.json": "paused",
    "_audit/default/events/2026-10-28/e1.jsonl": "event",
    "token-secrets/encryption-key": "key",
    "token-secrets/values/t1": "secret",
    "heartbeats/old": "beat",
    "active-runs/old/r1": "run",
    "claims/reconcile-instance/x": "claim",
  });
  const shared = memoryStore();
  assertEquals(await importCheckoutControlPlane(checkout, shared), 7);
  assertEquals(
    [...shared.data.keys()].sort(),
    [
      "_audit/default/events/2026-10-28/e1.jsonl",
      "dashboard-sessions/s1",
      "fire-records/w/2026-10-28T10-00-00Z",
      "pending-runs/p1",
      "schedule-pauses/nightly.json",
      "token-secrets/encryption-key",
      "token-secrets/values/t1",
    ],
  );
  assertEquals(checkout.data.has(CHECKOUT_IMPORT_SENTINEL), true);
});

Deno.test("importCheckoutControlPlane: runs once per checkout", async () => {
  const checkout = memoryStore({ "pending-runs/p1": "pending" });
  const shared = memoryStore();
  await importCheckoutControlPlane(checkout, shared);
  shared.data.clear();
  assertEquals(await importCheckoutControlPlane(checkout, shared), 0);
  assertEquals(shared.data.size, 0);
});

Deno.test("importCheckoutControlPlane: keeps what the shared store already holds", async () => {
  const checkout = memoryStore({ "pending-runs/p1": "old" });
  const shared = memoryStore({ "pending-runs/p1": "new" });
  assertEquals(await importCheckoutControlPlane(checkout, shared), 0);
  assertEquals(text(await shared.get("pending-runs/p1")), "new");
});

Deno.test("importCheckoutControlPlane: token secrets under another key stay behind", async () => {
  const checkout = memoryStore({
    "token-secrets/encryption-key": "mine",
    "token-secrets/values/t1": "secret",
  });
  const shared = memoryStore({ "token-secrets/encryption-key": "theirs" });
  assertEquals(await importCheckoutControlPlane(checkout, shared), 0);
  assertEquals(await shared.get("token-secrets/values/t1"), null);
  assertEquals(
    text(await shared.get("token-secrets/encryption-key")),
    "theirs",
  );
});

Deno.test("importCheckoutControlPlane: token secrets under the same key as the store's move", async () => {
  const checkout = memoryStore({
    "token-secrets/encryption-key": "same",
    "token-secrets/values/t1": "secret",
  });
  const shared = memoryStore({ "token-secrets/encryption-key": "same" });
  assertEquals(await importCheckoutControlPlane(checkout, shared), 1);
  assertEquals(text(await shared.get("token-secrets/values/t1")), "secret");
});

Deno.test("importCheckoutControlPlane: of two checkouts moving at once, only the one whose key the store keeps moves its values", async () => {
  const shared = memoryStore();
  const a = memoryStore({
    "token-secrets/encryption-key": "key-a",
    "token-secrets/values/shared-name": "from-a",
    "token-secrets/values/only-a": "a",
  });
  const b = memoryStore({
    "token-secrets/encryption-key": "key-b",
    "token-secrets/values/shared-name": "from-b",
    "token-secrets/values/only-b": "b",
  });
  await Promise.all([
    importCheckoutControlPlane(a, shared),
    importCheckoutControlPlane(b, shared),
  ]);
  const winner = text(await shared.get("token-secrets/encryption-key"));
  const mine = winner === "key-a" ? "a" : "b";
  const theirs = mine === "a" ? "b" : "a";
  assertEquals(
    text(await shared.get("token-secrets/values/shared-name")),
    `from-${mine}`,
  );
  assertEquals(await shared.get(`token-secrets/values/only-${theirs}`), null);
});
