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

import { SwampClient } from "../client/client.ts";
import { APP_READY_MESSAGE, type BridgePort } from "./bridge.ts";
import {
  type BridgeListeners,
  type BridgeSession,
  BridgeTransport,
} from "./bridge_transport.ts";

export interface ConnectedApp {
  readonly client: SwampClient;
  readonly session: BridgeSession;
  readonly transport: BridgeTransport;
}

async function open(
  listeners: BridgeListeners,
  port: BridgePort,
): Promise<ConnectedApp> {
  const transport = new BridgeTransport(port, listeners);
  const client = new SwampClient(transport);
  await client.connect();
  return { client, session: await transport.ready, transport };
}

function requestPort(): Promise<BridgePort> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== globalThis.parent || !event.ports[0]) return;
      globalThis.removeEventListener("message", onMessage);
      resolve(event.ports[0] as unknown as BridgePort);
    };
    globalThis.addEventListener("message", onMessage);
    // a frame's parent has no origin it can be addressed by from here
    globalThis.parent.postMessage(APP_READY_MESSAGE, "*");
  });
}

export type AppConnector = (
  listeners?: BridgeListeners,
  port?: BridgePort,
) => Promise<ConnectedApp>;

/** One connection per connector: the host refuses a second port request, and StrictMode runs effects twice. */
export function createAppConnector(): AppConnector {
  let connection: Promise<ConnectedApp> | null = null;
  return (listeners = {}, port) => {
    if (port !== undefined) return open(listeners, port);
    connection ??= requestPort().then((granted) => open(listeners, granted));
    return connection;
  };
}

/** Connects to the dashboard, or to a mock host's port when one is given. */
export const connectApp: AppConnector = createAppConnector();
