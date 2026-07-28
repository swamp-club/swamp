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
  | { kind: "error"; code: string; message: string };

export interface RunEventSubscriber {
  onEvent(seq: number, event: SerializedEvent): void;
  onTerminal(terminal: BufferTerminal): void;
  onDetach(): void;
}

interface SequencedEvent {
  seq: number;
  event: SerializedEvent;
}

export class RunEventBuffer {
  readonly #capacity: number;
  #events: SequencedEvent[] = [];
  #firstIndex = 0;
  #nextSeq = 1;
  #terminal: BufferTerminal | null = null;
  readonly #subscribers = new Set<RunEventSubscriber>();

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error("RunEventBuffer capacity must be at least 1");
    }
    this.#capacity = capacity;
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

  push(event: SerializedEvent): number {
    if (this.#terminal !== null) {
      throw new Error("Cannot push to a finished RunEventBuffer");
    }

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
      sub.onEvent(seq, event);
    }

    return seq;
  }

  finish(terminal: BufferTerminal): void {
    if (this.#terminal !== null) {
      throw new Error("RunEventBuffer is already finished");
    }
    this.#terminal = terminal;

    for (const sub of this.#subscribers) {
      sub.onTerminal(terminal);
    }
    for (const sub of this.#subscribers) {
      sub.onDetach();
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
