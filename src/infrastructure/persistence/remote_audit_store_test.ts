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
import { initializeLogging } from "../logging/logger.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { RemoteAuditStore } from "./remote_audit_store.ts";

await initializeLogging({});

function createInMemoryStore(): ControlPlaneStore & {
  data: Map<string, Uint8Array>;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(key: string, value: Uint8Array) {
      data.set(key, value);
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list(prefix: string) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("RemoteAuditStore: put prefixes key", async () => {
  const inner = createInMemoryStore();
  const store = new RemoteAuditStore(inner);

  await store.put("events/2026-09-04.jsonl", encoder.encode("data"));

  assertEquals(inner.data.has("_audit/events/2026-09-04.jsonl"), true);
});

Deno.test("RemoteAuditStore: get reads prefixed key", async () => {
  const inner = createInMemoryStore();
  inner.data.set("_audit/events/2026-09-04.jsonl", encoder.encode("data"));
  const store = new RemoteAuditStore(inner);

  const result = await store.get("events/2026-09-04.jsonl");
  assertEquals(decoder.decode(result!), "data");
});

Deno.test("RemoteAuditStore: get returns null for missing key", async () => {
  const inner = createInMemoryStore();
  const store = new RemoteAuditStore(inner);

  const result = await store.get("missing");
  assertEquals(result, null);
});

Deno.test("RemoteAuditStore: list strips prefix from keys", async () => {
  const inner = createInMemoryStore();
  inner.data.set("_audit/events/a.jsonl", encoder.encode(""));
  inner.data.set("_audit/events/b.jsonl", encoder.encode(""));
  inner.data.set("_audit/other/c.jsonl", encoder.encode(""));
  const store = new RemoteAuditStore(inner);

  const keys = await store.list("events/");
  assertEquals(keys.sort(), ["events/a.jsonl", "events/b.jsonl"]);
});

Deno.test("RemoteAuditStore: custom prefix", async () => {
  const inner = createInMemoryStore();
  const store = new RemoteAuditStore(inner, "custom-audit/");

  await store.put("test", encoder.encode("value"));
  assertEquals(inner.data.has("custom-audit/test"), true);
});

Deno.test("RemoteAuditStore: propagates put errors", async () => {
  const failing: ControlPlaneStore = {
    async put() {
      throw new Error("write failed");
    },
    async get() {
      return null;
    },
    async delete() {},
    async list() {
      return [];
    },
  };
  const store = new RemoteAuditStore(failing);

  await assertRejects(
    () => store.put("key", encoder.encode("data")),
    Error,
    "write failed",
  );
});
