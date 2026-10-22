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

import type { SerializedEvent } from "./protocol.ts";

export type BufferTerminal =
  | { kind: "done" }
  | { kind: "error"; code: string; message: string; details?: unknown };

export interface RunEventSubscriber {
  onEvent(seq: number, event: SerializedEvent): void;
  onTerminal(terminal: BufferTerminal): void;
  onDetach(): void;
}

interface SequencedEvent {
  seq: number;
  event: SerializedEvent;
}

/** The run events that report a run's outcome (swamp-club#3759). */
const OUTCOME_EVENT_KINDS: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "suspended",
]);

/** Options for a {@link RunEventBuffer}. */
export interface RunEventBufferOptions {
  /**
   * Holds the run's outcome event, and every event after it, until the
   * buffer finishes (swamp-club#3759): a v3 run commits when its root ends,
   * so followers see the outcome only with `done`, and never before an
   * `error` that replaces it.
   */
  readonly holdOutcome?: boolean;
}

export class RunEventBuffer {
  readonly #capacity: number;
  readonly #holdOutcome: boolean;
  /** Events held from the outcome on, delivered when the buffer is done. */
  #heldOutcome: SerializedEvent[] | undefined;
  #events: SequencedEvent[] = [];
  #firstIndex = 0;
  #nextSeq = 1;
  #terminal: BufferTerminal | null = null;
  readonly #subscribers = new Set<RunEventSubscriber>();

  constructor(capacity: number, options: RunEventBufferOptions = {}) {
    if (capacity < 1) {
      throw new Error("RunEventBuffer capacity must be at least 1");
    }
    this.#capacity = capacity;
    this.#holdOutcome = options.holdOutcome === true;
  }

  get finished(): boolean {
    return this.#terminal !== null;
  }

  get highSeq(): number {
    return this.#nextSeq - 1;
  }

  get length(): number {
    return this.#events.length - this.#firstIndex;
  }

  get firstSeq(): number {
    if (this.length === 0) return this.#nextSeq;
    return this.#events[this.#firstIndex].seq;
  }

  /**
   * Adds an event and delivers it, and returns its sequence number. A held
   * outcome event is delivered, numbered, when the buffer finishes `done`;
   * until then it returns the number it will have if delivered.
   */
  push(event: SerializedEvent): number {
    if (this.#terminal !== null) {
      throw new Error("Cannot push to a finished RunEventBuffer");
    }
    if (
      this.#holdOutcome &&
      (this.#heldOutcome !== undefined || OUTCOME_EVENT_KINDS.has(event.kind))
    ) {
      this.#heldOutcome ??= [];
      this.#heldOutcome.push(event);
      return this.#nextSeq + this.#heldOutcome.length - 1;
    }
    return this.#deliver(event);
  }

  #deliver(event: SerializedEvent): number {
    const seq = this.#nextSeq++;
    this.#events.push({ seq, event });

    if (this.length > this.#capacity) {
      this.#firstIndex++;
    }

    if (this.#firstIndex > 1000 && this.#firstIndex > this.#events.length / 2) {
      this.#events = this.#events.slice(this.#firstIndex);
      this.#firstIndex = 0;
    }

    for (const sub of this.#subscribers) {
      try {
        sub.onEvent(seq, event);
      } catch {
        // Subscriber errors must not break delivery to other subscribers
      }
    }

    return seq;
  }

  finish(terminal: BufferTerminal): void {
    if (this.#terminal !== null) {
      throw new Error("RunEventBuffer is already finished");
    }
    // The held outcome goes out only with `done`: an error replaces it.
    const held = this.#heldOutcome ?? [];
    this.#heldOutcome = undefined;
    if (terminal.kind === "done") {
      for (const event of held) this.#deliver(event);
    }
    this.#terminal = terminal;

    for (const sub of this.#subscribers) {
      try {
        sub.onTerminal(terminal);
      } catch {
        // Subscriber errors must not break delivery to other subscribers
      }
    }
    for (const sub of this.#subscribers) {
      try {
        sub.onDetach();
      } catch {
        // Subscriber errors must not break delivery to other subscribers
      }
    }
    this.#subscribers.clear();
  }

  subscribe(subscriber: RunEventSubscriber, afterSeq = 0): () => void {
    for (let i = this.#firstIndex; i < this.#events.length; i++) {
      const entry = this.#events[i];
      if (entry.seq > afterSeq) {
        subscriber.onEvent(entry.seq, entry.event);
      }
    }

    if (this.#terminal !== null) {
      subscriber.onTerminal(this.#terminal);
      subscriber.onDetach();
      return () => {};
    }

    this.#subscribers.add(subscriber);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.#subscribers.delete(subscriber);
      subscriber.onDetach();
    };
  }
}
