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

import type {
  AppInfo,
  AppTheme,
  BridgeFrame,
  BridgePort,
  HostMessage,
} from "./bridge.ts";
import { BRIDGE_VERSION, isAppMessage } from "./bridge.ts";
import { CANCEL_REQUEST, decideAppRequest } from "./capabilities.ts";

export interface MockHostOptions {
  readonly app?: Partial<AppInfo>;
  readonly theme?: AppTheme;
  /** Replies by request type: a payload, or a function of the request. */
  readonly responses?: Readonly<
    Record<string, unknown | ((payload: unknown) => unknown)>
  >;
  readonly health?: unknown;
  /** Events per request type, each then `done`; `data.subscribe` events are pages and the stream stays open. */
  readonly streams?: Readonly<
    Record<
      string,
      | readonly MockStreamEvent[]
      | ((
        payload: unknown,
      ) => readonly MockStreamEvent[] | AsyncIterable<MockStreamEvent>)
    >
  >;
}

/** One event a mocked stream plays, as serve would send it. */
export interface MockStreamEvent {
  readonly kind: string;
  readonly [field: string]: unknown;
}

const DEFAULT_THEME: AppTheme = { mode: "light", tokens: {} };

/** Holds messages until a handler is set, as a real `MessagePort` does. */
class MockPort implements BridgePort {
  peer: MockPort | null = null;
  private handler: BridgePort["onmessage"] = null;
  private waiting: unknown[] = [];

  get onmessage(): BridgePort["onmessage"] {
    return this.handler;
  }

  set onmessage(handler: BridgePort["onmessage"]) {
    this.handler = handler;
    for (const message of this.waiting.splice(0)) this.deliver(message);
  }

  postMessage(message: unknown): void {
    this.peer?.deliver(message);
  }

  close(): void {}

  private deliver(message: unknown): void {
    if (this.handler === null) {
      this.waiting.push(message);
      return;
    }
    const handler = this.handler;
    queueMicrotask(() => handler({ data: message }));
  }
}

function pair(): [BridgePort, BridgePort] {
  const a = new MockPort();
  const b = new MockPort();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Applies the broker's capability rules; one conformance suite holds both to them. */
export function createMockHost(options: MockHostOptions = {}): {
  readonly port: BridgePort;
  sendTheme(theme: AppTheme): void;
  sendHealth(snapshot: unknown): void;
} {
  const [appPort, hostPort] = pair();
  const app: AppInfo = {
    name: "@mock/app",
    title: "Mock",
    capabilities: [],
    run: [],
    methods: [],
    local: false,
    ...options.app,
  };
  const post = (message: HostMessage) => hostPort.postMessage(message);
  const reply = (frame: BridgeFrame) => post({ kind: "frame", frame });
  const stopped = new Set<string>();

  const play = async (
    type: string,
    id: string,
    payload: unknown,
    source: NonNullable<MockHostOptions["streams"]>[string],
  ) => {
    const events = typeof source === "function" ? source(payload) : source;
    if (type === "run.attach") {
      const runId = (payload as { runId?: string } | undefined)?.runId ?? "";
      reply({
        type: "run.attached",
        id,
        payload: {
          runId,
          kind: "workflow-run",
          startedAt: new Date(0).toISOString(),
        },
      });
    }
    if (type === "data.subscribe") {
      for await (const { kind: _kind, ...page } of events) {
        if (stopped.has(id)) return;
        reply({ type, id, payload: { ...page, done: false } });
      }
      return;
    }
    for await (const event of events) {
      if (stopped.has(id)) return;
      reply({ type: "event", id, event });
    }
    if (!stopped.has(id)) reply({ type: "done", id });
  };

  hostPort.onmessage = (event) => {
    const message = event.data;
    if (!isAppMessage(message)) return;
    if (message.kind === "health-subscribe") {
      if (app.capabilities.includes("health:read")) {
        post({ kind: "health", snapshot: options.health ?? {} });
      }
      return;
    }
    if (message.kind !== "frame") return;
    const { type, id, payload } = message.frame;
    if (type === CANCEL_REQUEST) {
      stopped.add(id);
      return;
    }
    const decision = decideAppRequest(app, type, payload);
    if (!decision.allowed) {
      reply({
        type: "error",
        id,
        error: { code: "app_capability_denied", message: decision.reason },
      });
      return;
    }
    const stream = options.streams?.[type];
    if (stream !== undefined) {
      void play(type, id, payload, stream).catch((error: unknown) =>
        reply({
          type: "error",
          id,
          error: {
            code: "mock_stream_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        })
      );
      return;
    }
    const response = options.responses?.[type];
    if (response === undefined) {
      reply({
        type: "error",
        id,
        error: { code: "not_found", message: `No mock reply for ${type}` },
      });
      return;
    }
    const value = typeof response === "function"
      ? (response as (payload: unknown) => unknown)(payload)
      : response;
    reply({ type, id, payload: value });
  };

  post({
    kind: "init",
    bridge: BRIDGE_VERSION,
    app,
    theme: options.theme ?? DEFAULT_THEME,
    connected: true,
    path: "/",
  });

  return {
    port: appPort,
    sendTheme: (theme) => post({ kind: "theme", theme }),
    sendHealth: (snapshot) => post({ kind: "health", snapshot }),
  };
}
