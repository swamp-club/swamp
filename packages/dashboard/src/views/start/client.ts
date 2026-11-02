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

import {
  RequestError,
  settleRequest,
  type WireFrame,
} from "../../client/stream.ts";

const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

const STABLE_AFTER_MS = 10_000;

interface Pending {
  onEvent?: (event: unknown) => void;
  payload?: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface StartClientOptions {
  onReconnect?: () => void;
  onStopped?: () => void;
}

export class StartClient {
  readonly #url: string;
  readonly #token: string;
  readonly #options: StartClientOptions;
  readonly #pending = new Map<string, Pending>();
  #ws: WebSocket | null = null;
  #connecting: WebSocket | null = null;
  #nextId = 0;
  #closed = false;
  #stopped = false;
  #attempts = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, token: string, options: StartClientOptions = {}) {
    this.#url = url;
    this.#token = token;
    this.#options = options;
  }

  static urlFor(location: Location): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/start/ws`;
  }

  connect(): Promise<void> {
    return this.#open(false);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#stableTimer);
    this.#failPending("The connection was closed.");
    this.#connecting?.close();
    this.#connecting = null;
    this.#ws?.close();
    this.#ws = null;
  }

  request<T>(type: string, payload?: unknown): Promise<T> {
    return this.#send(type, payload) as Promise<T>;
  }

  stream<T>(
    type: string,
    payload: unknown,
    onEvent: (event: unknown) => void,
  ): Promise<T> {
    return this.#send(type, payload, onEvent) as Promise<T>;
  }

  #send(
    type: string,
    payload: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to swamp start."));
    }
    const id = String(++this.#nextId);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { onEvent, resolve, reject });
      ws.send(JSON.stringify(
        payload === undefined ? { type, id } : { type, id, payload },
      ));
    });
  }

  #open(isRetry: boolean): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("The connection was closed."));
    }
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.#url, [`bearer.${this.#token}`]);
      this.#connecting = ws;
      ws.onopen = () => {
        if (this.#connecting === ws) this.#connecting = null;
        if (this.#closed) {
          ws.close();
          reject(new Error("The connection was closed."));
          return;
        }
        opened = true;
        this.#ws = ws;
        clearTimeout(this.#stableTimer);
        this.#stableTimer = setTimeout(() => {
          if (this.#ws === ws) this.#attempts = 0;
        }, STABLE_AFTER_MS);
        resolve();
        if (isRetry) this.#options.onReconnect?.();
      };
      ws.onmessage = (message) => this.#handle(message.data);
      ws.onclose = () => {
        if (this.#connecting === ws) this.#connecting = null;
        if (this.#ws === ws) {
          this.#ws = null;
          clearTimeout(this.#stableTimer);
        }
        if (!opened) {
          reject(new Error("Couldn't connect to swamp start."));
          // The first connect reports its own failure; a failed retry
          // tries again until the attempts run out.
          if (isRetry && !this.#closed) this.#retry();
          return;
        }
        this.#failPending("The connection to swamp start was lost.");
        if (this.#closed) return;
        this.#retry();
      };
    });
  }

  #retry(): void {
    const delay = RECONNECT_DELAYS_MS[this.#attempts];
    if (delay === undefined) {
      this.#stop();
      return;
    }
    this.#attempts++;
    this.#retryTimer = setTimeout(() => {
      if (this.#closed) return;
      this.#open(true).catch(() => {
        // A failed retry schedules the next one, or stops, on its own.
      });
    }, delay);
  }

  #stop(): void {
    if (this.#stopped || this.#closed) return;
    this.#stopped = true;
    this.#options.onStopped?.();
  }

  #failPending(message: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #handle(data: unknown): void {
    if (typeof data !== "string") return;
    let frame: WireFrame;
    try {
      frame = JSON.parse(data) as WireFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.id !== "string") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;

    if (pending.onEvent) {
      if (frame.type === "error" && frame.error) {
        this.#pending.delete(frame.id);
        pending.reject(new RequestError(frame.error.message, frame.error.code));
      } else if (frame.event !== undefined) {
        pending.onEvent(frame.event);
      } else if (frame.type === "done") {
        this.#pending.delete(frame.id);
        if (pending.payload === undefined) {
          pending.reject(new Error("swamp start ended the step early."));
        } else {
          pending.resolve(pending.payload);
        }
      } else if (frame.payload !== undefined) {
        pending.payload = frame.payload;
      }
      return;
    }

    const outcome = settleRequest(frame);
    if (outcome.kind === "ignore") return;
    this.#pending.delete(frame.id);
    if (outcome.kind === "resolve") {
      pending.resolve(outcome.value);
    } else {
      pending.reject(new RequestError(outcome.message, outcome.code));
    }
  }
}
