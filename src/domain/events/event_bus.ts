// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Event Bus for publishing and subscribing to domain events.
 *
 * Provides synchronous event dispatch to ensure index updates
 * happen immediately after repository mutations.
 */

import type { DomainEvent, EventType, RepositoryEvent } from "./types.ts";

/**
 * Handler function for domain events.
 */
export type EventHandler<T extends DomainEvent = RepositoryEvent> = (
  event: T,
) => void | Promise<void>;

/**
 * EventBus provides a simple pub/sub mechanism for domain events.
 *
 * Events are dispatched synchronously to all subscribers. If a handler
 * returns a Promise, the publish call will wait for it to resolve.
 */
export class EventBus {
  private handlers: Map<EventType | "*", EventHandler[]> = new Map();
  private batchContext: BatchContext | null = null;

  /**
   * Subscribes a handler to a specific event type.
   *
   * @param eventType - The event type to subscribe to
   * @param handler - The handler function
   * @returns Unsubscribe function
   */
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

  /**
   * Subscribes a handler to all events.
   *
   * @param handler - The handler function
   * @returns Unsubscribe function
   */
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

  /**
   * Publishes an event to all subscribed handlers.
   *
   * If batching is active, events are queued instead of immediately dispatched.
   *
   * @param event - The event to publish
   */
  async publish(event: RepositoryEvent): Promise<void> {
    if (this.batchContext) {
      this.batchContext.queue(event);
      return;
    }

    await this.dispatch(event);
  }

  /**
   * Dispatches an event to all handlers immediately.
   */
  private async dispatch(event: RepositoryEvent): Promise<void> {
    // Get type-specific handlers
    const typeHandlers = this.handlers.get(event.type) ?? [];

    // Get wildcard handlers
    const wildcardHandlers = this.handlers.get("*") ?? [];

    // Dispatch to all handlers
    const allHandlers = [...typeHandlers, ...wildcardHandlers];

    for (const handler of allHandlers) {
      await handler(event);
    }
  }

  /**
   * Runs a function with batched event processing.
   *
   * Events published during the function execution are queued
   * and dispatched after the function completes.
   *
   * @param fn - The function to run
   */
  async batch<T>(fn: () => T | Promise<T>): Promise<T> {
    const context = new BatchContext();
    this.batchContext = context;

    try {
      const result = await fn();

      // Dispatch all queued events
      for (const event of context.events) {
        await this.dispatch(event);
      }

      return result;
    } finally {
      this.batchContext = null;
    }
  }

  /**
   * Checks if batching is currently active.
   */
  get isBatching(): boolean {
    return this.batchContext !== null;
  }
}

/**
 * BatchContext holds queued events during batch operations.
 */
class BatchContext {
  private _events: RepositoryEvent[] = [];

  /**
   * Queues an event for later dispatch.
   */
  queue(event: RepositoryEvent): void {
    this._events.push(event);
  }

  /**
   * Returns all queued events.
   */
  get events(): ReadonlyArray<RepositoryEvent> {
    return this._events;
  }
}
