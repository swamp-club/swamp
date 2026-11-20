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
  SwampConnection,
  SwampTransport,
  SwampTransportHandlers,
} from "../client/client.ts";
import type { ServerMessage, ServerRequest } from "../client/protocol.ts";
import {
  type AppInfo,
  type AppMessage,
  type AppTheme,
  BRIDGE_VERSION,
  type BridgePort,
  type HostMessage,
} from "./bridge.ts";

export interface BridgeListeners {
  onTheme?(theme: AppTheme): void;
  onConnection?(connected: boolean): void;
  onHealth?(snapshot: unknown): void;
  onVisibility?(visible: boolean): void;
  onPath?(path: string): void;
}

/** What the host said in its `init` message. */
export interface BridgeSession {
  readonly app: AppInfo;
  readonly theme: AppTheme;
  readonly connected: boolean;
  readonly path: string;
}

/** The port stays open across serve reconnects, which the host reports with `connection` messages. */
export class BridgeTransport implements SwampTransport, SwampConnection {
  // the port is the app's only channel; the host reconnects to serve behind it
  readonly reopens = false;
  private port: BridgePort;
  private frames: SwampTransportHandlers | null = null;
  private listeners: BridgeListeners;
  private opened = false;
  private session: Promise<BridgeSession>;
  private settle!: (session: BridgeSession) => void;
  private fail!: (error: Error) => void;

  constructor(port: BridgePort, listeners: BridgeListeners = {}) {
    this.port = port;
    this.listeners = listeners;
    this.session = new Promise((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    // a caller that only reads `ready` later must not see an unhandled reject
    this.session.catch(() => {});
    port.onmessage = (event) => this.receive(event.data as HostMessage);
  }

  /** Resolves with the host's `init`, or rejects on a bridge version clash. */
  get ready(): Promise<BridgeSession> {
    return this.session;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(handlers: SwampTransportHandlers): Promise<SwampConnection> {
    this.frames = handlers;
    await this.session;
    this.opened = true;
    return this;
  }

  send(request: ServerRequest): void {
    this.post({ kind: "frame", frame: request });
  }

  post(message: AppMessage): void {
    this.port.postMessage(message);
  }

  close(): void {
    this.opened = false;
    this.port.close();
    this.frames?.onClose();
  }

  private receive(message: HostMessage): void {
    switch (message.kind) {
      case "init":
        if (message.bridge !== BRIDGE_VERSION) {
          this.fail(
            new Error(
              `This app needs bridge ${BRIDGE_VERSION} and the dashboard speaks ${message.bridge}. Rebuild the app against this swamp.`,
            ),
          );
          return;
        }
        this.settle({
          app: message.app,
          theme: message.theme,
          connected: message.connected,
          path: message.path,
        });
        return;
      case "frame":
        this.frames?.onFrame(message.frame as unknown as ServerMessage);
        return;
      case "theme":
        this.listeners.onTheme?.(message.theme);
        return;
      case "connection":
        this.listeners.onConnection?.(message.connected);
        return;
      case "health":
        this.listeners.onHealth?.(message.snapshot);
        return;
      case "visibility":
        this.listeners.onVisibility?.(message.visible);
        return;
      case "path":
        this.listeners.onPath?.(message.path);
        return;
    }
  }
}
