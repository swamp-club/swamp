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

import { maxOf } from "../../domain/array_extrema.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";

const logger = getSwampLogger(["datastore", "v3", "serve-feed"]);

const MAX_BACKOFF_MS = 30_000;
/** a catch-up still writing when the command ends is left to the next one */
const STOP_WAIT_MS = 500;
/**
 * the feed's catch-ups start at most once per window, so a command's reads may
 * lag other writers by one window more; a quarter second matches the lock
 * waiters' backoff cap (MODEL_LOCK_MAX_BACKOFF_MS)
 */
export const FEED_CATCH_UP_WINDOW_MS = 250;

export interface ServeFeedWatch {
  stop(): Promise<void>;
  /**
   * runs `work`, a lock's catch-up of the copy and its read model: a feed
   * catch-up asked for before it is dropped once it succeeded and reached
   * every cursor the feed asked for
   */
  coveredBy<T>(work: () => Promise<T>): Promise<T>;
}

export interface ServeFeedWatchOptions {
  readonly target: Pick<
    ServeUpstreamTarget,
    "serverUrl" | "token" | "caCerts" | "extraHeaders"
  >;
  /**
   * Runs the checkout's catch-up; called again only once it settled. Stopping
   * the watch aborts `signal`, so a command's exit never waits on it.
   */
  catchUp(signal: AbortSignal): Promise<unknown>;
  readonly appliedCursor?: () => number;
  readonly sentHere?: (txnId: string) => boolean;
  readonly catchUpLocally?: (signal: AbortSignal) => Promise<unknown>;
  /**
   * a serve catch-up waits for it, then runs only if the copy is still short
   * of the cursor that asked for it: the command's own catch-up is under way
   */
  readonly ready?: (signal: AbortSignal) => Promise<void>;
  readonly openSocket?: (url: string, headers: Headers) => WebSocket;
  readonly stopWaitMs?: number;
  /** zero or less starts each catch-up as soon as the last one settled */
  readonly windowMs?: number;
  /** returns the cancel */
  readonly scheduleWindow?: (fire: () => void, ms: number) => () => void;
}

interface FeedCatchUp {
  readonly kind: "serve" | "local";
  readonly wanted: number | undefined;
  /** the furthest cursor a serve frame asked for */
  readonly reach: number;
}

// a serve catch-up includes the local one, so a pending one is never downgraded
function merged(
  pending: FeedCatchUp | undefined,
  next: FeedCatchUp,
): FeedCatchUp {
  if (pending === undefined) return next;
  return {
    kind: pending.kind === "serve" || next.kind === "serve" ? "serve" : "local",
    wanted: undefined,
    reach: Math.max(pending.reach, next.reach),
  };
}

function scheduleTimer(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms);
  Deno.unrefTimer(timer);
  return () => clearTimeout(timer);
}

export function watchServeFeed(options: ServeFeedWatchOptions): ServeFeedWatch {
  let stopped = false;
  let socket: WebSocket | undefined;
  let backoff = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let pending: FeedCatchUp | undefined;
  let closeWindow: (() => void) | undefined;
  let covering = 0;
  const windowMs = options.windowMs ?? FEED_CATCH_UP_WINDOW_MS;
  const scheduleWindow = options.scheduleWindow ?? scheduleTimer;
  const caCerts = options.target.caCerts;
  const httpClient = caCerts !== undefined && caCerts.length > 0
    ? Deno.createHttpClient({ caCerts: [...caCerts] })
    : undefined;

  const sentHere = (change: unknown): boolean => {
    if (options.sentHere === undefined) return false;
    const txnId = (change as { commit?: { txnId?: unknown } } | null)?.commit
      ?.txnId;
    return typeof txnId === "string" && options.sentHere(txnId);
  };

  const stopping = new AbortController();
  const serveCatchUp = async (wanted: number | undefined) => {
    if (options.ready !== undefined) {
      await options.ready(stopping.signal);
      if (
        wanted !== undefined && options.appliedCursor !== undefined &&
        options.appliedCursor() >= wanted
      ) {
        return;
      }
    }
    return await options.catchUp(stopping.signal);
  };
  const drain = () => {
    if (
      stopped || pending === undefined || running !== undefined ||
      closeWindow !== undefined || covering > 0
    ) {
      return;
    }
    const next = pending;
    pending = undefined;
    if (windowMs > 0) {
      closeWindow = scheduleWindow(() => {
        closeWindow = undefined;
        drain();
      }, windowMs);
    }
    const run = next.kind === "serve"
      ? serveCatchUp(next.wanted)
      : options.catchUpLocally!(stopping.signal);
    running = run.catch((error) => {
      logger.debug`Catching up from serve's commit feed failed: ${error}`;
    }).finally(() => {
      running = undefined;
      drain();
    });
  };
  const catchUp = (kind: "serve" | "local", wanted: number) => {
    if (stopped) return;
    if (kind === "local" && options.catchUpLocally === undefined) return;
    pending = merged(pending, {
      kind,
      wanted,
      reach: kind === "serve" ? wanted : Number.NEGATIVE_INFINITY,
    });
    drain();
  };
  // the lock's page was read at its grant, so a frame for a later commit may
  // still precede it here: only the read model and the reach it got are covered
  const coveredByCursor = (covered: FeedCatchUp): boolean =>
    covered.kind === "local" ||
    (options.appliedCursor !== undefined &&
      options.appliedCursor() >= covered.reach);

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
    // a frame that arrived before close() is still dispatched, after the
    // command may have closed the state the handlers read
    current.onopen = () => {
      if (stopped) return;
      current.send(JSON.stringify({ type: "commits.head", id: "head" }));
    };
    current.onmessage = (event) => {
      if (stopped || typeof event.data !== "string") return;
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
        if (
          options.appliedCursor === undefined ||
          cursor > options.appliedCursor()
        ) {
          catchUp("serve", cursor);
        }
        backoff = 1_000;
        return;
      }
      if (frame.id !== "feed") return;
      if (frame.type === "error") {
        current.close(1000, "resubscribing");
        return;
      }
      const changes = frame.payload?.changes;
      if (!Array.isArray(changes) || changes.length === 0) return;
      // the copy holds this process's own commits already: only its read
      // model is brought up, without asking serve
      const wanted = maxOf(
        changes.map((change) =>
          typeof (change as { cursor?: unknown } | null)?.cursor === "number"
            ? (change as { cursor: number }).cursor
            : Number.POSITIVE_INFINITY
        ),
      ) ?? Number.POSITIVE_INFINITY;
      catchUp(
        changes.every((change) => sentHere(change)) ? "local" : "serve",
        wanted,
      );
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
    async coveredBy<T>(work: () => Promise<T>): Promise<T> {
      if (stopped) return await work();
      covering++;
      const covered = pending;
      pending = undefined;
      let done = false;
      try {
        const result = await work();
        done = true;
        return result;
      } finally {
        covering--;
        if (
          covered !== undefined && !stopped &&
          !(done && coveredByCursor(covered))
        ) {
          pending = pending === undefined ? covered : merged(covered, pending);
        }
        drain();
      }
    },
    async stop() {
      stopped = true;
      stopping.abort();
      pending = undefined;
      closeWindow?.();
      closeWindow = undefined;
      if (timer !== undefined) clearTimeout(timer);
      if (socket !== undefined) {
        socket.onopen = null;
        socket.onmessage = null;
      }
      if (socket !== undefined && socket.readyState <= WebSocket.OPEN) {
        try {
          socket.close(1000, "command finished");
        } catch {
          // Already closing.
        }
      }
      if (running !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.stopWaitMs ?? STOP_WAIT_MS);
        });
        try {
          await Promise.race([running, bound]);
        } finally {
          clearTimeout(timer);
        }
      }
      httpClient?.close();
    },
  };
}
