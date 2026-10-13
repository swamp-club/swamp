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

import { AuditChainState } from "./audit_chain.ts";
import {
  type AuditCategory,
  type ChainedAuditEvent,
  createAuditEvent,
} from "./audit_event.ts";
import type { AuditStore } from "./audit_store.ts";

/** A chained event with the given action and resource, stored as swamp writes it. */
export function chainedEvent(
  chain: AuditChainState,
  action: string,
  resourceKind: string,
  resourceName: string,
  category: AuditCategory = "execution",
): Promise<ChainedAuditEvent> {
  return chain.chain(createAuditEvent({
    instanceId: "inst-1",
    category,
    stage: "response",
    outcome: "success",
    action,
    resourceKind,
    resourceName,
    principalKind: "user",
    principalId: "user-1",
    initiatedBy: "user:user-1",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  }));
}

/** An in-memory audit store holding `events`, one batch per day. */
export function inMemoryAuditStore(events: ChainedAuditEvent[]): AuditStore {
  const encoder = new TextEncoder();
  const storage = new Map<string, Uint8Array>();
  const byDate = new Map<string, ChainedAuditEvent[]>();
  for (const event of events) {
    const date = event.timestamp.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), event]);
  }
  for (const [date, dayEvents] of byDate) {
    storage.set(
      `events/${date}/batch.jsonl`,
      encoder.encode(dayEvents.map((e) => JSON.stringify(e)).join("\n") + "\n"),
    );
  }
  return {
    put(key, data) {
      storage.set(key, data);
      return Promise.resolve();
    },
    get(key) {
      return Promise.resolve(storage.get(key) ?? null);
    },
    list(prefix) {
      return Promise.resolve(
        [...storage.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
    delete(key) {
      storage.delete(key);
      return Promise.resolve();
    },
  };
}

export { AuditChainState };
