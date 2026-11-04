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
  type AuthInfo,
  type AuthMode,
  type Connection,
  createConnection,
  type SocketHandlers,
  type SocketLike,
  type Timers,
} from "../client/connection.ts";
import type { ProbeResult } from "../client/reconnect.ts";
import {
  type HttpReadOutcome,
  type HttpReadRequest,
  HttpReads,
} from "../client/http_request.ts";
import {
  RequestError,
  settleRequest,
  type WireFrame,
} from "../client/stream.ts";
import { endsRequest } from "../../../client/stream.ts";

export interface AppSocket extends SocketLike {
  send(data: string): void;
}

export interface AppConnectionDeps extends Timers {
  createSocket(
    protocols: string[] | undefined,
    handlers: SocketHandlers,
  ): AppSocket;
  probe(token: string | null, signal: AbortSignal): Promise<ProbeResult>;
  fetchAuthInfo(signal: AbortSignal): Promise<AuthInfo | null>;
  readOverHttp(
    request: HttpReadRequest,
    signal: AbortSignal,
  ): Promise<HttpReadOutcome>;
  newId?(): string;
}

export interface AppConnectionAuth {
  readonly token: string | null;
  readonly authMode: AuthMode | null;
  readonly sessionReady: boolean;
}

/** What the dashboard's own connection would start with, or null to stay closed. */
export function appConnectionStart(
  auth: AppConnectionAuth,
): { token: string | null; authMode: AuthMode } | null {
  if (auth.authMode === "none") return { token: null, authMode: "none" };
  if (auth.sessionReady && auth.authMode !== null && auth.token !== null) {
    return { token: auth.token, authMode: auth.authMode };
  }
  return null;
}

const disconnected = (id: string): WireFrame => ({
  type: "error",
  id,
  error: { code: "disconnected", message: "WebSocket closed" },
});

/** Its own socket, so serve's per-socket limits bound this app alone. */
export class AppConnection {
  readonly #deps: AppConnectionDeps;
  readonly #connection: Connection;
  readonly #routes = new Map<string, (frame: WireFrame) => void>();
  readonly #httpReads = new HttpReads();
  readonly #onConnection: (connected: boolean) => void;
  #socket: AppSocket | null = null;
  #closed = false;

  constructor(
    deps: AppConnectionDeps,
    onConnection: (connected: boolean) => void,
  ) {
    this.#deps = deps;
    this.#onConnection = onConnection;
    this.#connection = createConnection<AppSocket>({
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      createSocket: deps.createSocket,
      probe: deps.probe,
      fetchAuthInfo: deps.fetchAuthInfo,
      onOpen: (socket) => {
        this.#socket = socket;
        this.#onConnection(true);
      },
      onMessage: (_socket, text) => this.#receive(text),
      onDisconnect: () => this.#lost(),
      // the dashboard's connection asks the viewer to sign in again, and its new session restarts this one
      onReauth: () => {},
      onAuthModeChanged: () => {},
    });
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /** Connects, or reconnects with new credentials; null closes the socket. */
  start(options: { token: string | null; authMode: AuthMode } | null): void {
    if (this.#closed) return;
    if (options === null) this.#connection.stop();
    else this.#connection.start(options);
  }

  /** Sends a frame as is and hands back every frame addressed to its id. */
  sendFrame(frame: WireFrame, onFrame: (frame: WireFrame) => void): void {
    const socket = this.#socket;
    if (socket === null) {
      onFrame({
        type: "error",
        id: frame.id,
        error: { code: "disconnected", message: "Not connected" },
      });
      return;
    }
    if (frame.type === "cancel") this.#routes.delete(frame.id);
    else this.#routes.set(frame.id, onFrame);
    socket.send(JSON.stringify(frame));
  }

  /** A read on serve's HTTP route, answered on this socket when serve says so. */
  async request(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const outcome = await this.#httpReads.run(
      this.connected,
      (signal) =>
        this.#deps.readOverHttp(
          {
            type,
            id: this.#newId(),
            ...(payload !== undefined && { payload }),
          },
          signal,
        ),
    );
    if (outcome.kind === "payload") return outcome.value;
    if (outcome.kind === "signed_out") throw new Error(outcome.message);
    return await this.#overSocket(type, payload);
  }

  close(): void {
    this.#closed = true;
    this.#connection.stop();
    this.#httpReads.abortAll();
    this.#routes.clear();
  }

  #newId(): string {
    return this.#deps.newId?.() ?? crypto.randomUUID();
  }

  #overSocket(
    type: string,
    payload: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.sendFrame(
        {
          type,
          id: this.#newId(),
          ...(payload !== undefined && { payload }),
        },
        (frame) => {
          const outcome = settleRequest(frame);
          if (outcome.kind === "ignore") return;
          if (outcome.kind === "reject") {
            reject(
              new RequestError(outcome.message, outcome.code, outcome.details),
            );
            return;
          }
          resolve(outcome.value);
        },
      );
    });
  }

  #receive(text: string): void {
    let frame: WireFrame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const route = this.#routes.get(frame.id);
    if (route === undefined) return;
    if (endsRequest(frame)) this.#routes.delete(frame.id);
    route(frame);
  }

  /** The socket went: every request on it ends, as the dashboard's do. */
  #lost(): void {
    this.#socket = null;
    this.#httpReads.abortAll();
    const routes = [...this.#routes];
    this.#routes.clear();
    for (const [id, route] of routes) route(disconnected(id));
    if (!this.#closed) this.#onConnection(false);
  }
}
