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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  AuditChainState,
  CHAIN_SEED_DIGEST,
  verifyChain,
} from "./audit_chain.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { ChainedAuditEvent } from "./audit_event.ts";

function makeEvent(action: string): ReturnType<typeof createAuditEvent> {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

Deno.test("AuditChainState: assigns incrementing sequence numbers", async () => {
  const chain = new AuditChainState();
  const a = await chain.chain(makeEvent("a"));
  const b = await chain.chain(makeEvent("b"));

  assertEquals(a.sequence, 1);
  assertEquals(b.sequence, 2);
});

Deno.test("AuditChainState: sets version to 1", async () => {
  const chain = new AuditChainState();
  const event = await chain.chain(makeEvent("test"));

  assertEquals(event.version, 1);
});

Deno.test("AuditChainState: computes non-empty digest", async () => {
  const chain = new AuditChainState();
  const event = await chain.chain(makeEvent("test"));

  assertEquals(event.digest.length, 64);
  assertNotEquals(event.digest, CHAIN_SEED_DIGEST);
});

Deno.test("AuditChainState: each event has a different digest", async () => {
  const chain = new AuditChainState();
  const a = await chain.chain(makeEvent("a"));
  const b = await chain.chain(makeEvent("b"));

  assertNotEquals(a.digest, b.digest);
});

Deno.test("AuditChainState: chain is deterministic for same input", async () => {
  const event = makeEvent("deterministic");
  const chain1 = new AuditChainState();
  const chain2 = new AuditChainState();
  const result1 = await chain1.chain(event);
  const result2 = await chain2.chain(event);

  assertEquals(result1.digest, result2.digest);
  assertEquals(result1.sequence, result2.sequence);
});

Deno.test("AuditChainState: preserves all original event fields", async () => {
  const chain = new AuditChainState();
  const original = makeEvent("preserve");
  const chained = await chain.chain(original);

  assertEquals(chained.id, original.id);
  assertEquals(chained.timestamp, original.timestamp);
  assertEquals(chained.action, original.action);
  assertEquals(chained.category, original.category);
  assertEquals(chained.instanceId, original.instanceId);
});

Deno.test("AuditChainState: can resume from saved state", async () => {
  const chain1 = new AuditChainState();
  await chain1.chain(makeEvent("first"));

  const chain2 = new AuditChainState(
    chain1.sequence,
    chain1.previousDigest,
  );
  const secondEvent = makeEvent("second");
  const event2a = await chain1.chain(secondEvent);
  const event2b = await chain2.chain(secondEvent);

  assertEquals(event2a.digest, event2b.digest);
  assertEquals(event2a.sequence, event2b.sequence);
});

Deno.test("verifyChain: valid chain passes verification", async () => {
  const chain = new AuditChainState();
  const events: ChainedAuditEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push(await chain.chain(makeEvent(`action-${i}`)));
  }

  const result = await verifyChain(events);
  assertEquals(result.valid, true);
  assertEquals(result.brokenAt, undefined);
});

Deno.test("verifyChain: detects tampered event", async () => {
  const chain = new AuditChainState();
  const events: ChainedAuditEvent[] = [];
  for (let i = 0; i < 3; i++) {
    events.push(await chain.chain(makeEvent(`action-${i}`)));
  }

  const tampered = [
    events[0],
    { ...events[1], action: "tampered" } as ChainedAuditEvent,
    events[2],
  ];

  const result = await verifyChain(tampered);
  assertEquals(result.valid, false);
  assertEquals(result.brokenAt, events[1].sequence);
});

Deno.test("verifyChain: detects missing event", async () => {
  const chain = new AuditChainState();
  const events: ChainedAuditEvent[] = [];
  for (let i = 0; i < 4; i++) {
    events.push(await chain.chain(makeEvent(`action-${i}`)));
  }

  const gapped = [events[0], events[2], events[3]];

  const result = await verifyChain(gapped);
  assertEquals(result.valid, false);
  assertEquals(result.brokenAt, events[2].sequence);
});

Deno.test("verifyChain: empty chain is valid", async () => {
  const result = await verifyChain([]);
  assertEquals(result.valid, true);
});

Deno.test("verifyChain: can verify from a custom start digest", async () => {
  const chain = new AuditChainState();
  const events: ChainedAuditEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push(await chain.chain(makeEvent(`action-${i}`)));
  }

  const midDigest = events[1].digest;
  const tail = events.slice(2);

  const result = await verifyChain(tail, midDigest);
  assertEquals(result.valid, true);
});
