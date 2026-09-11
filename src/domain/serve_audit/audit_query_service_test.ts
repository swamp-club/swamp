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
import { AuditQueryService } from "./audit_query_service.ts";
import { AuditChainState } from "./audit_chain.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { AuditCategory, ChainedAuditEvent } from "./audit_event.ts";
import type { AuditStore } from "./audit_store.ts";
import {
  generateHmacKeyBytes,
  HmacKeyRegistry,
  importHmacKey,
} from "./audit_hmac.ts";

const encoder = new TextEncoder();

function makeChainedEvent(
  action: string,
  chain: AuditChainState,
  overrides: Partial<{
    category: string;
    outcome: string;
    principalId: string;
    resourceKind: string;
    resourceName: string;
    timestamp: string;
  }> = {},
): Promise<ChainedAuditEvent> {
  const event = createAuditEvent({
    instanceId: "inst-1",
    category: (overrides.category ?? "execution") as AuditCategory,
    stage: "response",
    outcome: (overrides.outcome ?? "success") as
      | "success"
      | "failure"
      | "denied",
    action,
    resourceKind: overrides.resourceKind ?? "model",
    resourceName: overrides.resourceName ?? "test-model",
    principalKind: "user",
    principalId: overrides.principalId ?? "user-1",
    initiatedBy: `user:${overrides.principalId ?? "user-1"}`,
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
  if (overrides.timestamp) {
    return chain.chain({ ...event, timestamp: overrides.timestamp });
  }
  return chain.chain(event);
}

function createInMemoryStore(
  events: ChainedAuditEvent[],
): AuditStore {
  const dateMap = new Map<string, ChainedAuditEvent[]>();
  for (const event of events) {
    const date = event.timestamp.slice(0, 10);
    const existing = dateMap.get(date) ?? [];
    existing.push(event);
    dateMap.set(date, existing);
  }

  const storage = new Map<string, Uint8Array>();
  for (const [date, dateEvents] of dateMap) {
    const jsonl = dateEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    storage.set(`events/${date}/batch.jsonl`, encoder.encode(jsonl));
  }

  return {
    put(key: string, data: Uint8Array): Promise<void> {
      storage.set(key, data);
      return Promise.resolve();
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(storage.get(key) ?? null);
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...storage.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
    delete(key: string): Promise<void> {
      storage.delete(key);
      return Promise.resolve();
    },
  };
}

Deno.test("AuditQueryService.query: returns all events with no filters", async () => {
  const chain = new AuditChainState();
  const events = [
    await makeChainedEvent("model.method.run", chain),
    await makeChainedEvent("vault.get", chain),
  ];
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.query({});
  assertEquals(result.events.length, 2);
});

Deno.test("AuditQueryService.query: filters by principal", async () => {
  const chain = new AuditChainState();
  const events = [
    await makeChainedEvent("a", chain, { principalId: "user-1" }),
    await makeChainedEvent("b", chain, { principalId: "user-2" }),
    await makeChainedEvent("c", chain, { principalId: "user-1" }),
  ];
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.query({ principal: "user-1" });
  assertEquals(result.events.length, 2);
});

Deno.test("AuditQueryService.query: filters by action", async () => {
  const chain = new AuditChainState();
  const events = [
    await makeChainedEvent("vault.get", chain),
    await makeChainedEvent("model.method.run", chain),
    await makeChainedEvent("vault.get", chain),
  ];
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.query({ action: "vault.get" });
  assertEquals(result.events.length, 2);
});

Deno.test("AuditQueryService.query: respects limit", async () => {
  const chain = new AuditChainState();
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push(await makeChainedEvent(`action-${i}`, chain));
  }
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.query({ limit: 3 });
  assertEquals(result.events.length, 3);
  assertEquals(result.total, 10);
});

Deno.test("AuditQueryService.query: empty store returns empty", async () => {
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store);

  const result = await service.query({});
  assertEquals(result.events.length, 0);
});

Deno.test("AuditQueryService.verify: valid chain passes", async () => {
  const chain = new AuditChainState();
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push(await makeChainedEvent(`action-${i}`, chain));
  }
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.verify();
  assertEquals(result.valid, true);
  assertEquals(result.eventsChecked, 5);
});

Deno.test("AuditQueryService.verify: empty store is valid", async () => {
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store);

  const result = await service.verify();
  assertEquals(result.valid, true);
  assertEquals(result.eventsChecked, 0);
});

Deno.test("AuditQueryService.verify: detects tampering", async () => {
  const chain = new AuditChainState();
  const events = [];
  for (let i = 0; i < 3; i++) {
    events.push(await makeChainedEvent(`action-${i}`, chain));
  }
  events[1] = { ...events[1], action: "tampered" } as ChainedAuditEvent;
  const store = createInMemoryStore(events);
  const service = new AuditQueryService(store);

  const result = await service.verify();
  assertEquals(result.valid, false);
});

// queryStream tests

function createMultiDateStore(
  eventsByDate: Map<string, ChainedAuditEvent[]>,
): AuditStore {
  const storage = new Map<string, Uint8Array>();
  for (const [date, dateEvents] of eventsByDate) {
    const jsonl = dateEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    storage.set(`events/${date}/batch.jsonl`, encoder.encode(jsonl));
  }
  return {
    put(key: string, data: Uint8Array): Promise<void> {
      storage.set(key, data);
      return Promise.resolve();
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(storage.get(key) ?? null);
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...storage.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
    delete(key: string): Promise<void> {
      storage.delete(key);
      return Promise.resolve();
    },
  };
}

Deno.test("AuditQueryService.queryStream: yields events per partition", async () => {
  const chain = new AuditChainState();
  const date1 = "2026-09-01";
  const date2 = "2026-09-02";
  const e1 = await makeChainedEvent("a", chain, {
    timestamp: `${date1}T10:00:00.000Z`,
  });
  const e2 = await makeChainedEvent("b", chain, {
    timestamp: `${date2}T10:00:00.000Z`,
  });
  const eventsByDate = new Map<string, ChainedAuditEvent[]>([
    [date1, [e1]],
    [date2, [e2]],
  ]);
  const store = createMultiDateStore(eventsByDate);
  const service = new AuditQueryService(store);

  const batches: ChainedAuditEvent[][] = [];
  for await (
    const batch of service.queryStream({
      since: `${date1}T00:00:00.000Z`,
      until: `${date2}T23:59:59.999Z`,
    })
  ) {
    batches.push(batch);
  }
  assertEquals(batches.length, 2);
  assertEquals(batches[0].length, 1);
  assertEquals(batches[1].length, 1);
});

Deno.test("AuditQueryService.queryStream: applies filters", async () => {
  const chain = new AuditChainState();
  const date = "2026-09-01";
  const e1 = await makeChainedEvent("vault.get", chain, {
    category: "secrets",
    timestamp: `${date}T10:00:00.000Z`,
  });
  const e2 = await makeChainedEvent("model.run", chain, {
    category: "execution",
    timestamp: `${date}T11:00:00.000Z`,
  });
  const eventsByDate = new Map<string, ChainedAuditEvent[]>([
    [date, [e1, e2]],
  ]);
  const store = createMultiDateStore(eventsByDate);
  const service = new AuditQueryService(store);

  const batches: ChainedAuditEvent[][] = [];
  for await (
    const batch of service.queryStream({
      since: `${date}T00:00:00.000Z`,
      until: `${date}T23:59:59.999Z`,
      category: "secrets",
    })
  ) {
    batches.push(batch);
  }
  assertEquals(batches.length, 1);
  assertEquals(batches[0].length, 1);
  assertEquals(batches[0][0].action, "vault.get");
});

// verifyHmac tests

async function makeHmacKeyRegistry() {
  const raw = await generateHmacKeyBytes();
  const key = await importHmacKey(raw);
  return new HmacKeyRegistry([{ version: 1, key }]);
}

Deno.test("AuditQueryService.verifyHmac: no registry returns valid with 0 checked", () => {
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store);
  const result = service.verifyHmac([]);
  assertEquals(result, { valid: true, checked: 0, failed: 0 });
});

Deno.test("AuditQueryService.verifyHmac: valid events pass", async () => {
  const registry = await makeHmacKeyRegistry();
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store, registry);
  const validHex = "a".repeat(64);
  const event = {
    id: "e1",
    timestamp: "2026-09-01T00:00:00.000Z",
    instanceId: "inst-1",
    category: "secrets" as const,
    stage: "response" as const,
    outcome: "success" as const,
    action: "vault.get",
    resourceKind: "vault",
    resourceName: validHex,
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    hmacKeyVersion: 1,
    version: 1 as const,
    sequence: 1,
    digest: "abc",
  };
  const result = service.verifyHmac([event]);
  assertEquals(result, { valid: true, checked: 1, failed: 0 });
});

Deno.test("AuditQueryService.verifyHmac: unknown key version fails", async () => {
  const registry = await makeHmacKeyRegistry();
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store, registry);
  const validHex = "b".repeat(64);
  const event = {
    id: "e1",
    timestamp: "2026-09-01T00:00:00.000Z",
    instanceId: "inst-1",
    category: "secrets" as const,
    stage: "response" as const,
    outcome: "success" as const,
    action: "vault.get",
    resourceKind: "vault",
    resourceName: validHex,
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    hmacKeyVersion: 99,
    version: 1 as const,
    sequence: 1,
    digest: "abc",
  };
  const result = service.verifyHmac([event]);
  assertEquals(result, { valid: false, checked: 1, failed: 1 });
});

Deno.test("AuditQueryService.verifyHmac: malformed resourceName fails", async () => {
  const registry = await makeHmacKeyRegistry();
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store, registry);
  const event = {
    id: "e1",
    timestamp: "2026-09-01T00:00:00.000Z",
    instanceId: "inst-1",
    category: "secrets" as const,
    stage: "response" as const,
    outcome: "success" as const,
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "not-a-hex-hash",
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    hmacKeyVersion: 1,
    version: 1 as const,
    sequence: 1,
    digest: "abc",
  };
  const result = service.verifyHmac([event]);
  assertEquals(result, { valid: false, checked: 1, failed: 1 });
});

Deno.test("AuditQueryService.verifyHmac: malformed detail fails", async () => {
  const registry = await makeHmacKeyRegistry();
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store, registry);
  const validHex = "c".repeat(64);
  const event = {
    id: "e1",
    timestamp: "2026-09-01T00:00:00.000Z",
    instanceId: "inst-1",
    category: "secrets" as const,
    stage: "response" as const,
    outcome: "success" as const,
    action: "vault.get",
    resourceKind: "vault",
    resourceName: validHex,
    detail: "not-hex",
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    hmacKeyVersion: 1,
    version: 1 as const,
    sequence: 1,
    digest: "abc",
  };
  const result = service.verifyHmac([event]);
  assertEquals(result, { valid: false, checked: 1, failed: 1 });
});

Deno.test("AuditQueryService.verifyHmac: events without hmacKeyVersion are skipped", async () => {
  const registry = await makeHmacKeyRegistry();
  const store = createInMemoryStore([]);
  const service = new AuditQueryService(store, registry);
  const event = {
    id: "e1",
    timestamp: "2026-09-01T00:00:00.000Z",
    instanceId: "inst-1",
    category: "secrets" as const,
    stage: "response" as const,
    outcome: "success" as const,
    action: "vault.get",
    resourceKind: "vault",
    resourceName: "plain-text-name",
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    version: 1 as const,
    sequence: 1,
    digest: "abc",
  };
  const result = service.verifyHmac([event]);
  assertEquals(result, { valid: true, checked: 0, failed: 0 });
});
