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
  type AppGrant,
  CANCEL_REQUEST,
  decideAppRequest,
  METHOD_REQUEST,
  RUN_REQUEST,
} from "../../../app-sdk/capabilities.ts";
import {
  type AppInfo,
  type AppTheme,
  BRIDGE_VERSION,
  type BridgeFrame,
  type BridgePort,
  type HostMessage,
  isAppMessage,
} from "../../../app-sdk/bridge.ts";
import { endsRequest } from "../../../client/stream.ts";

export const APP_RUN_TAG = "swamp.app";

/** Keeps an app from flooding the browser's history. */
export const MIN_NAVIGATION_GAP_MS = 250;

/** A path inside the app; anything else could leave its route. */
export function isAppPath(path: string): boolean {
  if (path.length > 2000) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return /^\/[^\\]*$/.test(decoded) && !decoded.startsWith("//") &&
    !decoded.split("/").some((segment) => segment === "." || segment === "..");
}

/** The app's side of the dashboard, over the app's own socket to serve. */
export interface BrokerHost {
  /** Sends a frame and hands back every frame addressed to it. */
  sendFrame(frame: BridgeFrame, onFrame: (frame: BridgeFrame) => void): void;
  /** Whether a type's replies go over HTTP rather than the socket. */
  isHttpRead(type: string): boolean;
  request(type: string, payload?: Record<string, unknown>): Promise<unknown>;
  subscribeHealth(onSnapshot: (snapshot: unknown) => void): () => void;
  navigate(path: string): void;
  /** Closes the app's socket; serve ends what was in flight on it. */
  close(): void;
  now?(): number;
}

export interface BrokerOptions {
  readonly app: AppInfo;
  readonly theme: AppTheme;
  readonly connected: boolean;
  readonly path: string;
  readonly host: BrokerHost;
}

/** Runs in the dashboard's realm, out of the app's reach, so what it refuses stays refused. */
export class AppBroker {
  readonly #port: BridgePort;
  readonly #options: BrokerOptions;
  readonly #grant: AppGrant;
  /** The app's request id to the id it travels under. */
  readonly #inFlight = new Map<string, string>();
  /** Reads on the HTTP route; serve knows no id for these, so they run out. */
  readonly #httpReads = new Set<string>();
  #unsubscribeHealth: (() => void) | null = null;
  #closed = false;
  #sequence = 0;
  #lastNavigation = 0;

  constructor(port: BridgePort, options: BrokerOptions) {
    this.#port = port;
    this.#options = options;
    this.#grant = {
      capabilities: options.app.capabilities,
      run: options.app.run,
      methods: options.app.methods,
    };
    port.onmessage = (event) => this.#receive(event.data);
    this.#post({
      kind: "init",
      bridge: BRIDGE_VERSION,
      app: options.app,
      theme: options.theme,
      connected: options.connected,
      path: options.path,
    });
  }

  setTheme(theme: AppTheme): void {
    this.#post({ kind: "theme", theme });
  }

  setVisible(visible: boolean): void {
    this.#post({ kind: "visibility", visible });
  }

  setPath(path: string): void {
    this.#post({ kind: "path", path });
  }

  /** The bridge outlives the socket, so a lost socket fails its requests. */
  setConnected(connected: boolean): void {
    this.#post({ kind: "connection", connected });
    if (connected) return;
    for (const id of [...this.#inFlight.keys()]) {
      this.#settle(id);
      this.#reply({
        type: "error",
        id,
        error: { code: "disconnected", message: "WebSocket closed" },
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeHealth?.();
    this.#unsubscribeHealth = null;
    this.#inFlight.clear();
    this.#httpReads.clear();
    this.#port.onmessage = null;
    this.#port.close();
    this.#options.host.close();
  }

  #post(message: HostMessage): void {
    if (!this.#closed) this.#port.postMessage(message);
  }

  #reply(frame: BridgeFrame): void {
    this.#post({ kind: "frame", frame });
  }

  #settle(id: string): void {
    this.#inFlight.delete(id);
    this.#httpReads.delete(id);
  }

  #refuse(id: string, code: string, message: string): void {
    this.#reply({ type: "error", id, error: { code, message } });
  }

  #receive(message: unknown): void {
    if (this.#closed || !isAppMessage(message)) return;
    switch (message.kind) {
      case "frame":
        this.#handleFrame(message.frame);
        return;
      case "health-subscribe":
        if (
          this.#unsubscribeHealth === null &&
          this.#grant.capabilities.includes("health:read")
        ) {
          this.#unsubscribeHealth = this.#options.host.subscribeHealth(
            (snapshot) => this.#post({ kind: "health", snapshot }),
          );
        }
        return;
      case "health-unsubscribe":
        this.#unsubscribeHealth?.();
        this.#unsubscribeHealth = null;
        return;
      case "navigate":
        if (isAppPath(message.path) && this.#mayNavigate()) {
          this.#options.host.navigate(message.path);
        }
        return;
    }
  }

  #handleFrame(frame: BridgeFrame): void {
    if (frame.type === CANCEL_REQUEST) {
      // serve cancels a whole run when handed a run id, so only an id this app
      // issued is passed on, under the id it travels by
      const travelling = this.#inFlight.get(frame.id);
      // serve knows no id for an HTTP read, so it runs out
      if (travelling !== undefined && !this.#httpReads.has(frame.id)) {
        this.#options.host.sendFrame(
          { type: CANCEL_REQUEST, id: travelling },
          () => {},
        );
        // a detach sends nothing back, so the app's request ends here
        this.#settle(frame.id);
        this.#refuse(frame.id, "cancelled", "Stopped following this request.");
      }
      return;
    }
    if (this.#inFlight.has(frame.id)) {
      this.#refuse(frame.id, "duplicate_id", "That request id is in use.");
      return;
    }
    const decision = decideAppRequest(this.#grant, frame.type, frame.payload);
    if (!decision.allowed) {
      this.#refuse(frame.id, "app_capability_denied", decision.reason);
      return;
    }
    // never the app's own id: a cancel serve no longer matches to a request
    // cancels the run with that id, so a travelling id must never be a run's
    const travelling = `app:${++this.#sequence}`;
    this.#inFlight.set(frame.id, travelling);
    const payload = this.#outboundPayload(frame);
    if (this.#options.host.isHttpRead(frame.type)) {
      this.#httpReads.add(frame.id);
      this.#options.host.request(
        frame.type,
        payload as Record<string, unknown> | undefined,
      ).then((value) => {
        if (this.#inFlight.get(frame.id) !== travelling) return;
        this.#settle(frame.id);
        this.#reply({ type: frame.type, id: frame.id, payload: value });
      }).catch((error: unknown) => {
        if (this.#inFlight.get(frame.id) !== travelling) return;
        this.#settle(frame.id);
        this.#refuse(
          frame.id,
          "request_failed",
          error instanceof Error ? error.message : String(error),
        );
      });
      return;
    }
    this.#options.host.sendFrame(
      {
        type: frame.type,
        id: travelling,
        ...(payload !== undefined ? { payload } : {}),
      },
      (reply) => {
        if (this.#inFlight.get(frame.id) !== travelling) return;
        if (endsRequest(reply)) this.#settle(frame.id);
        this.#reply({ ...reply, id: frame.id });
      },
    );
  }

  /** Only what an app may choose about a run; checks and locks stay as set. */
  #outboundPayload(frame: BridgeFrame): unknown {
    if (frame.type === METHOD_REQUEST) return this.#methodPayload(frame);
    if (frame.type === "data.query" || frame.type === "data.get") {
      return withoutInParts(frame.payload);
    }
    if (frame.type !== RUN_REQUEST) return frame.payload;
    const { workflowIdOrName, inputs, runtimeTags } = frame.payload as Record<
      string,
      unknown
    >;
    return {
      workflowIdOrName,
      ...(inputs !== undefined ? { inputs } : {}),
      runtimeTags: {
        ...(runtimeTags as Record<string, string> | undefined),
        [APP_RUN_TAG]: this.#options.app.name,
      },
    };
  }

  /** Inputs stay data: evaluated, they would read as the viewer, past the grant. */
  #methodPayload(frame: BridgeFrame): unknown {
    const {
      modelIdOrName,
      methodName,
      inputs,
      typeArg,
      definitionName,
      runtimeTags,
    } = frame.payload as Record<string, unknown>;
    const pinned = this.#grant.methods.find((entry) =>
      entry.behavior === modelIdOrName
    );
    return {
      modelIdOrName,
      methodName,
      literalInputs: true,
      // taken from the grant, never the app, so serve refuses any other type
      ...(pinned !== undefined ? { expectedType: pinned.type } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(typeArg !== undefined ? { typeArg } : {}),
      ...(definitionName !== undefined ? { definitionName } : {}),
      runtimeTags: {
        ...(runtimeTags as Record<string, string> | undefined),
        [APP_RUN_TAG]: this.#options.app.name,
      },
    };
  }

  #mayNavigate(): boolean {
    const now = this.#options.host.now?.() ?? Date.now();
    if (now - this.#lastNavigation < MIN_NAVIGATION_GAP_MS) return false;
    this.#lastNavigation = now;
    return true;
  }
}

// the dashboard reads one reply; a reply in parts is for swamp's own CLI
function withoutInParts(payload: unknown): unknown {
  if (
    payload === null || typeof payload !== "object" || !("inParts" in payload)
  ) {
    return payload;
  }
  const { inParts: _inParts, ...rest } = payload as Record<string, unknown>;
  return rest;
}
