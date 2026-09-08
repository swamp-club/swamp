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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type {
  AuditCategory,
  AuditEvent,
  AuditOutcome,
} from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";

const logger = getSwampLogger(["serve", "audit", "websocket-sink"]);

export interface AuditSubscriptionFilter {
  readonly categories?: readonly AuditCategory[];
  readonly principals?: readonly string[];
  readonly actions?: readonly string[];
  readonly outcomes?: readonly AuditOutcome[];
  readonly resourceKind?: string;
}

export interface AuditSubscription {
  readonly id: string;
  readonly socket: WebSocket;
  readonly filter: AuditSubscriptionFilter;
}

function matchesFilter(
  event: AuditEvent,
  filter: AuditSubscriptionFilter,
): boolean {
  if (
    filter.categories && filter.categories.length > 0 &&
    !filter.categories.includes(event.category)
  ) {
    return false;
  }
  if (
    filter.principals && filter.principals.length > 0 &&
    !filter.principals.includes(event.principalId)
  ) {
    return false;
  }
  if (
    filter.actions && filter.actions.length > 0 &&
    !filter.actions.includes(event.action)
  ) {
    return false;
  }
  if (
    filter.outcomes && filter.outcomes.length > 0 &&
    !filter.outcomes.includes(event.outcome)
  ) {
    return false;
  }
  if (
    filter.resourceKind !== undefined &&
    event.resourceKind !== filter.resourceKind
  ) {
    return false;
  }
  return true;
}

export class WebSocketSink implements AuditSink {
  readonly name = "websocket";
  readonly durable = false;
  readonly #subscriptions = new Map<string, AuditSubscription>();

  subscribe(subscription: AuditSubscription): void {
    this.#subscriptions.set(subscription.id, subscription);
    logger.info(
      "Audit subscription {id} registered, {count} active",
      { id: subscription.id, count: this.#subscriptions.size },
    );
  }

  unsubscribe(id: string): void {
    if (this.#subscriptions.delete(id)) {
      logger.info(
        "Audit subscription {id} removed, {count} active",
        { id, count: this.#subscriptions.size },
      );
    }
  }

  get subscriptionCount(): number {
    return this.#subscriptions.size;
  }

  subscriptionsForSocket(socket: WebSocket): string[] {
    const ids: string[] = [];
    for (const [id, sub] of this.#subscriptions) {
      if (sub.socket === socket) ids.push(id);
    }
    return ids;
  }

  async write(events: readonly AuditEvent[]): Promise<void> {
    if (this.#subscriptions.size === 0) return;

    for (const [id, sub] of this.#subscriptions) {
      if (sub.socket.readyState !== WebSocket.OPEN) {
        this.#subscriptions.delete(id);
        continue;
      }

      for (const event of events) {
        if (!matchesFilter(event, sub.filter)) continue;
        try {
          sub.socket.send(JSON.stringify({
            type: "audit.event",
            id: sub.id,
            payload: { event },
          }));
        } catch {
          this.#subscriptions.delete(id);
          break;
        }
      }
    }
    await Promise.resolve();
  }

  async flush(): Promise<void> {
    await Promise.resolve();
  }

  async close(): Promise<void> {
    this.#subscriptions.clear();
    await Promise.resolve();
  }
}
