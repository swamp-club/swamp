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

import { localSocketProtocols, serverPath } from "./workspace_path.ts";
import {
  type AuthAnswer,
  type AuthInfo,
  requestAuthAnswer,
  requestAuthInfo,
  requestTokenProbe,
  type SocketHandlers,
  type Timers,
} from "./connection.ts";
import type { ProbeResult } from "./reconnect.ts";

function getWsUrl(socketPath: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Ask serve to send large responses as gzip binary frames.
  return `${proto}//${location.host}${socketPath}?compress=gzip`;
}

export const browserTimers: Timers = {
  setTimer: (fn: () => void, ms: number) =>
    Number(globalThis.setTimeout(fn, ms)),
  clearTimer: (id: number) => globalThis.clearTimeout(id),
};

export const fetchAuthInfo = (signal: AbortSignal): Promise<AuthInfo | null> =>
  requestAuthInfo(globalThis.fetch, signal);

export const fetchAuthAnswer = (
  signal: AbortSignal,
): Promise<AuthAnswer | null> => requestAuthAnswer(globalThis.fetch, signal);

export const probeToken = (
  token: string | null,
  signal: AbortSignal,
): Promise<ProbeResult> => requestTokenProbe(globalThis.fetch, token, signal);

async function gunzipFrame(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}

/** Authenticates as every dashboard socket does: the session cookie, or the local token as a subprotocol. */
export function openServeSocket(
  protocols: string[] | undefined,
  handlers: SocketHandlers,
  socketPath: string = serverPath("/"),
): WebSocket {
  const ws = new WebSocket(
    getWsUrl(socketPath),
    localSocketProtocols() ?? protocols,
  );
  ws.binaryType = "arraybuffer";
  ws.onopen = () => handlers.onOpen();
  // Every frame goes through one chain so a text frame never overtakes an
  // earlier compressed frame that is still being decoded.
  let frameChain: Promise<void> = Promise.resolve();
  ws.onmessage = (event) => {
    const data: unknown = event.data;
    frameChain = frameChain
      .then(async () => {
        handlers.onMessage(
          typeof data === "string"
            ? data
            : await gunzipFrame(data as ArrayBuffer),
        );
      })
      .catch((err: unknown) => {
        console.error("swamp: dropped an undecodable frame", err);
      });
  };
  ws.onclose = (event) => handlers.onClose(event.code);
  return ws;
}
