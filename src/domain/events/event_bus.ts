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

/**
 * dispatch is synchronous so index updates happen immediately after repository
 * mutations
 */

import type { DomainEvent, EventType, RepositoryEvent } from "./types.ts";

export type EventHandler<T extends DomainEvent = RepositoryEvent> = (
  event: T,
) => void | Promise<void>;

export class EventBus {
  private handlers: Map<EventType | "*", EventHandler[]> = new Map();
  private batchContext: BatchContext | null = null;

  subscribe<T extends RepositoryEvent>(
    eventType: T["type"],
    handler: EventHandler<T>,
  ): () => void {
    const handlers = this.handlers.get(eventType) ?? [];
    handlers.push(handler as EventHandler);
    this.handlers.set(eventType, handlers);

    return () => {
      const currentHandlers = this.handlers.get(eventType) ?? [];
      const index = currentHandlers.indexOf(handler as EventHandler);
      if (index !== -1) {
        currentHandlers.splice(index, 1);
      }
    };
  }

  subscribeAll(handler: EventHandler<RepositoryEvent>): () => void {
    const handlers = this.handlers.get("*") ?? [];
    handlers.push(handler);
    this.handlers.set("*", handlers);

    return () => {
      const currentHandlers = this.handlers.get("*") ?? [];
      const index = currentHandlers.indexOf(handler);
      if (index !== -1) {
        currentHandlers.splice(index, 1);
      }
    };
  }

  async publish(event: RepositoryEvent): Promise<void> {
    if (this.batchContext) {
      this.batchContext.queue(event);
      return;
    }

    await this.dispatch(event);
  }

  private async dispatch(event: RepositoryEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type) ?? [];

    const wildcardHandlers = this.handlers.get("*") ?? [];

    const allHandlers = [...typeHandlers, ...wildcardHandlers];

    for (const handler of allHandlers) {
      await handler(event);
    }
  }

  async batch<T>(fn: () => T | Promise<T>): Promise<T> {
    const context = new BatchContext();
    this.batchContext = context;

    try {
      const result = await fn();

      for (const event of context.events) {
        await this.dispatch(event);
      }

      return result;
    } finally {
      this.batchContext = null;
    }
  }

  get isBatching(): boolean {
    return this.batchContext !== null;
  }
}

class BatchContext {
  private _events: RepositoryEvent[] = [];

  queue(event: RepositoryEvent): void {
    this._events.push(event);
  }

  get events(): ReadonlyArray<RepositoryEvent> {
    return this._events;
  }
}
