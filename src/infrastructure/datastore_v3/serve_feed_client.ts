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

/**
 * the watch is only a wake-up: each frame with commits runs the checkout's own
 * catch-up, so filtering, base loads and gap handling stay in one place; a
 * dropped socket reopens with backoff
 */

import { getSwampLogger } from "../logging/logger.ts";
import type { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";

const logger = getSwampLogger(["datastore", "v3", "serve-feed"]);

const MAX_BACKOFF_MS = 30_000;

export interface ServeFeedWatch {
  stop(): Promise<void>;
}

export interface ServeFeedWatchOptions {
  readonly target: Pick<
    ServeUpstreamTarget,
    "serverUrl" | "token" | "caCerts" | "extraHeaders"
  >;
  /** Runs the checkout's catch-up; called again only once it settled. */
  catchUp(): Promise<unknown>;
  readonly openSocket?: (url: string, headers: Headers) => WebSocket;
}

export function watchServeFeed(options: ServeFeedWatchOptions): ServeFeedWatch {
  let stopped = false;
  let socket: WebSocket | undefined;
  let backoff = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let again = false;
  const caCerts = options.target.caCerts;
  const httpClient = caCerts !== undefined && caCerts.length > 0
    ? Deno.createHttpClient({ caCerts: [...caCerts] })
    : undefined;

  const catchUp = () => {
    if (running !== undefined) {
      again = true;
      return;
    }
    running = options.catchUp().catch((error) => {
      logger.debug`Catching up from serve's commit feed failed: ${error}`;
    }).finally(() => {
      running = undefined;
      if (again && !stopped) {
        again = false;
        catchUp();
      }
    });
  };

  const open = () => {
    if (stopped) return;
    const url = new URL(options.target.serverUrl);
    url.protocol = url.protocol === "https:" || url.protocol === "wss:"
      ? "wss:"
      : "ws:";
    const headers = new Headers(options.target.extraHeaders ?? {});
    if (options.target.token !== undefined) {
      headers.set("authorization", `Bearer ${options.target.token}`);
    }
    try {
      socket = options.openSocket !== undefined
        ? options.openSocket(url.toString(), headers)
        : new WebSocket(url, {
          headers,
          ...(httpClient !== undefined ? { client: httpClient } : {}),
        } as unknown as string[]);
    } catch (error) {
      logger.debug`Opening serve's commit feed failed: ${error}`;
      retry();
      return;
    }
    const current = socket;
    current.onopen = () => {
      current.send(JSON.stringify({ type: "commits.head", id: "head" }));
    };
    current.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let frame: {
        type?: unknown;
        id?: unknown;
        payload?: { cursor?: unknown; changes?: unknown };
      };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type === "commits.head" && frame.id === "head") {
        const cursor = frame.payload?.cursor;
        if (typeof cursor !== "number") return;
        current.send(JSON.stringify({
          type: "commits.subscribe",
          id: "feed",
          payload: { cursor },
        }));
        // Anything committed between the command's own catch-up and the
        // head just read is read now.
        catchUp();
        backoff = 1_000;
        return;
      }
      if (frame.id !== "feed") return;
      if (frame.type === "error") {
        current.close(1000, "resubscribing");
        return;
      }
      const changes = frame.payload?.changes;
      if (Array.isArray(changes) && changes.length > 0) catchUp();
    };
    current.onerror = () => {};
    current.onclose = () => {
      if (socket === current) socket = undefined;
      retry();
    };
  };

  const retry = () => {
    if (stopped) return;
    timer = setTimeout(open, backoff);
    Deno.unrefTimer(timer);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  open();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
        try {
          socket.close(1000, "command finished");
        } catch {
          // Already closing.
        }
      }
      await running;
      httpClient?.close();
    },
  };
}
