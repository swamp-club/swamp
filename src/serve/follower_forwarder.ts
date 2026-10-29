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
 * Forwarding a client's WebSocket requests from a serve follower to its
 * team's leader (swamp-club#4120).
 *
 * At upgrade a follower keeps the caller's credential (the bearer token, or
 * the dashboard session cookie with its Origin) as connection-private state,
 * never in socket metadata or logs. The first request the follower does not
 * answer itself opens one socket to the leader for that client connection,
 * with that credential: the leader authenticates and authorises the caller
 * as if it had connected directly, so the follower never says who the
 * caller is. Requests pass through unchanged by id, and every frame the
 * leader sends comes back to the client. A cancel for a forwarded request,
 * or for a run the follower does not have, passes on too.
 *
 * A worker's connection is relayed whole from its first RPC frame: from
 * then on the worker is in the leader's pool.
 *
 * When the leader's socket closes with requests in flight, each gets the
 * `serve_not_leader` refusal, marked `inFlight` when the request had been
 * sent: it may already have run, so it is never sent again. A close the
 * leader gave the session (revoked, expired) closes the client the same way.
 *
 * @module
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { ServeNotLeaderError } from "../domain/datastore_v3/serve_leader.ts";
import type { LeaderLink } from "./leader_link.ts";
import { closeSession, sendError, sendSerialized } from "./handlers/shared.ts";

const logger = getSwampLogger(["serve", "follower-forwarder"]);

/** Close codes the leader ends a session with that end the client's too. */
const SESSION_CLOSE_CODES: ReadonlySet<number> = new Set([4002, 4003]);

/**
 * What a follower needs to reach the leader as the caller: the headers that
 * carry the caller's credential, and the path and query the caller
 * connected with (credentials and compression removed).
 */
export interface ForwardCredential {
  readonly headers: Readonly<Record<string, string>>;
  readonly pathAndQuery: string;
}

const credentials = new WeakMap<WebSocket, ForwardCredential>();
const forwarders = new WeakMap<WebSocket, FollowerForwarder>();

/**
 * The caller's credential from its upgrade request, read before the upgrade
 * (the request's headers cannot be read after it): the bearer token (from
 * the header, the `bearer.` subprotocol or the query) as an `Authorization`
 * header, or the dashboard session cookie with the browser's Origin. With
 * auth off, no credential: the leader takes the caller as it takes any
 * caller then.
 */
export function forwardCredentialOf(
  req: Request,
  credential:
    | { kind: "bearer"; token: string }
    | { kind: "cookie" }
    | { kind: "none" },
  clientIp: string,
  trustProxy = false,
): ForwardCredential {
  const headers: Record<string, string> = {};
  if (credential.kind === "bearer") {
    headers["authorization"] = `Bearer ${credential.token}`;
  } else if (credential.kind === "cookie") {
    const cookie = req.headers.get("cookie");
    const origin = req.headers.get("origin");
    if (cookie !== null) headers["cookie"] = cookie;
    if (origin !== null) headers["origin"] = origin;
  }
  // The address this node took the caller's from: its own peer's, unless
  // it trusts the proxy in front of it, so a caller cannot name the address
  // the leader limits and audits it by.
  const prior = trustProxy ? req.headers.get("x-forwarded-for") : null;
  headers["x-forwarded-for"] = prior ? `${prior}, ${clientIp}` : clientIp;
  const url = new URL(req.url);
  // The token travels in the header, and the leader's frames come back as
  // text: the follower compresses them for its client as the client asked.
  url.searchParams.delete("token");
  url.searchParams.delete("compress");
  return { headers, pathAndQuery: url.pathname + url.search };
}

/** Keeps `credential` for `socket`, for its forwards to the leader. */
export function rememberForwardCredential(
  socket: WebSocket,
  credential: ForwardCredential,
): void {
  credentials.set(socket, credential);
}

/**
 * The forwarder for `socket`, made on first use; undefined when this node
 * has no route to a leader or kept no credential for the socket.
 */
export function forwarderFor(
  socket: WebSocket,
  link: LeaderLink | undefined,
  barrier?: () => Promise<void>,
): FollowerForwarder | undefined {
  const existing = forwarders.get(socket);
  if (existing !== undefined) return existing;
  const credential = credentials.get(socket);
  if (link === undefined || credential === undefined) return undefined;
  const forwarder = new FollowerForwarder(socket, link, credential, barrier);
  forwarders.set(socket, forwarder);
  return forwarder;
}

/** The forwarder `socket` already has, if any. */
export function existingForwarder(
  socket: WebSocket,
): FollowerForwarder | undefined {
  return forwarders.get(socket);
}

/** Whether `raw` is a worker's RPC frame (`rpc.*`). */
export function isRpcFrame(raw: string): boolean {
  if (!raw.includes('"rpc.')) return false;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" && parsed.type.startsWith("rpc.");
  } catch {
    return false;
  }
}

interface Upstream {
  readonly socket: WebSocket;
  readonly queue: (string | ArrayBuffer | Blob)[];
  open: boolean;
}

interface Forwarded {
  readonly type: string;
  sent: boolean;
  readonly done: () => void;
  /** The relay of this request's frames, in order. */
  chain: Promise<void>;
}

/** One client connection's route to the leader. */
export class FollowerForwarder {
  readonly #client: WebSocket;
  readonly #link: LeaderLink;
  readonly #credential: ForwardCredential;
  readonly #barrier?: () => Promise<void>;
  readonly #pending = new Map<string, Forwarded>();
  #upstream: Upstream | undefined;
  #relaying = false;
  #closed = false;

  constructor(
    client: WebSocket,
    link: LeaderLink,
    credential: ForwardCredential,
    barrier?: () => Promise<void>,
  ) {
    this.#client = client;
    this.#link = link;
    this.#credential = credential;
    this.#barrier = barrier;
    client.addEventListener("close", () => this.close());
  }

  /** Whether the whole connection is relayed (a worker's). */
  get relaying(): boolean {
    return this.#relaying;
  }

  /**
   * Passes request `id` of `type` (its raw frame `raw`) to the leader.
   * Returns false when no leader can be reached: the caller refuses it.
   * `done` runs once the request's last frame came back, or it failed;
   * aborting `signal` while the client is connected cancels it upstream.
   */
  forward(
    id: string,
    type: string,
    raw: string,
    signal: AbortSignal,
    done: () => void,
  ): boolean {
    const upstream = this.#connect();
    if (upstream === undefined) return false;
    const entry: Forwarded = {
      type,
      sent: false,
      done,
      chain: Promise.resolve(),
    };
    this.#pending.set(id, entry);
    signal.addEventListener("abort", () => {
      // A client that went away closes the leader's socket instead, as its
      // own disconnect would have.
      if (this.#client.readyState !== WebSocket.OPEN) return;
      if (this.#pending.get(id) !== entry) return;
      this.#send(JSON.stringify({ type: "cancel", id }));
      // A cancelled request may end with no frame (a detached attach): its
      // slot is free now, and any frame still coming passes through.
      this.#pending.delete(id);
      entry.chain = entry.chain.then(() => entry.done());
    }, { once: true });
    this.#send(raw, entry);
    return true;
  }

  /**
   * Passes a client's `cancel` for `id` on when this node has nothing of
   * that id: a run executes on the leader, never on a follower.
   */
  cancel(raw: string): void {
    // Opened for it when this connection forwarded nothing yet: a client
    // that reconnected cancels a run it started on another connection.
    if (this.#connect() === undefined) return;
    this.#send(raw);
  }

  /**
   * Relays the whole connection from `raw` on: a worker's, whose first RPC
   * frame (its enrollment) came to a follower. Returns false when no leader
   * can be reached.
   */
  relay(raw: string): boolean {
    this.#relaying = true;
    const upstream = this.#connect();
    if (upstream === undefined) {
      this.#relaying = false;
      return false;
    }
    this.#send(raw);
    return true;
  }

  /** Relays one more frame of a relayed connection. */
  relayFrame(data: string | ArrayBuffer | Blob): void {
    const upstream = this.#upstream;
    if (upstream === undefined) return;
    this.#send(data);
  }

  /** Closes the leader's socket, once the client's is gone. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const upstream = this.#upstream;
    this.#upstream = undefined;
    if (upstream !== undefined && upstream.socket.readyState <= 1) {
      try {
        upstream.socket.close(1000, "client closed");
      } catch {
        // Already closing.
      }
    }
  }

  #connect(): Upstream | undefined {
    if (this.#closed) return undefined;
    if (this.#upstream !== undefined) return this.#upstream;
    let opened;
    try {
      opened = this.#link.openSocket(
        this.#credential.pathAndQuery,
        this.#credential.headers,
      );
    } catch (error) {
      logger.info`Opening a socket to the leader failed: ${error}`;
      return undefined;
    }
    if (opened === undefined) return undefined;
    const socket = opened.socket;
    socket.binaryType = "arraybuffer";
    const upstream: Upstream = { socket, queue: [], open: false };
    this.#upstream = upstream;
    socket.onopen = () => {
      upstream.open = true;
      for (const frame of upstream.queue.splice(0)) socket.send(frame);
      for (const entry of this.#pending.values()) entry.sent = true;
    };
    socket.onmessage = (event) => this.#fromLeader(event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => this.#leaderClosed(upstream, event);
    return upstream;
  }

  #send(raw: string | ArrayBuffer | Blob, entry?: Forwarded): void {
    const upstream = this.#upstream;
    if (upstream === undefined) return;
    if (upstream.open && upstream.socket.readyState === WebSocket.OPEN) {
      upstream.socket.send(raw);
      if (entry !== undefined) entry.sent = true;
    } else {
      upstream.queue.push(raw);
    }
  }

  #fromLeader(data: unknown): void {
    if (typeof data !== "string") {
      // Only a relayed worker connection carries binary frames.
      if (this.#relaying && this.#client.readyState === WebSocket.OPEN) {
        this.#client.send(data as ArrayBuffer);
      }
      return;
    }
    if (this.#relaying) {
      if (this.#client.readyState === WebSocket.OPEN) this.#client.send(data);
      return;
    }
    const frame = parseFrame(data);
    const entry = frame?.id !== undefined
      ? this.#pending.get(frame.id)
      : undefined;
    if (frame === undefined || entry === undefined) {
      sendSerialized(this.#client, data);
      return;
    }
    const final = isFinalFrame(frame, entry.type);
    if (final) this.#pending.delete(frame.id!);
    entry.chain = entry.chain.then(async () => {
      // The caller reads its own write from this node next: the reply
      // waits until this node's copy holds what the leader had committed.
      if (final && frame.type !== "error" && this.#barrier !== undefined) {
        await this.#barrier().catch(() => {});
      }
      sendSerialized(this.#client, data);
      if (final) entry.done();
    });
  }

  #leaderClosed(upstream: Upstream, event: CloseEvent): void {
    if (this.#upstream === upstream) this.#upstream = undefined;
    if (SESSION_CLOSE_CODES.has(event.code) || this.#relaying) {
      if (this.#client.readyState === WebSocket.OPEN) {
        const code = event.code >= 3000 && event.code <= 4999
          ? event.code
          : 1000;
        closeSession(this.#client, code, event.reason);
      }
    }
    const leader = this.#link.leader();
    for (const [id, entry] of [...this.#pending]) {
      this.#pending.delete(id);
      entry.chain = entry.chain.then(() => {
        const refusal = new ServeNotLeaderError(leader, false, entry.sent);
        sendError(
          this.#client,
          id,
          refusal.code,
          refusal.message,
          entry.sent
            ? { inFlight: true }
            : leader !== undefined
            ? { leader }
            : undefined,
        );
        entry.done();
      });
    }
  }
}

/** Replies of another type that end a request, by request type. */
const FINAL_REPLY_TYPES: Readonly<Record<string, readonly string[]>> = {
  // A run live elsewhere, or one that ended without its stream.
  "run.attach": ["run.elsewhere", "run.interrupted"],
};

interface Frame {
  readonly type: string;
  readonly id?: string;
  readonly payload?: unknown;
}

function parseFrame(raw: string): Frame | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.type !== "string") return undefined;
    return {
      type: parsed.type,
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      payload: parsed.payload,
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether `frame` is the last the leader sends for a request of
 * `requestType`: an error or `done` frame, or a reply that is not a stream
 * event and does not say more follows (`payload.done: false`).
 */
export function isFinalFrame(frame: Frame, requestType: string): boolean {
  if (frame.type === "error" || frame.type === "done") return true;
  if (FINAL_REPLY_TYPES[requestType]?.includes(frame.type)) return true;
  if (frame.type === "event") return false;
  if (frame.type !== requestType) return false;
  const payload = frame.payload as { done?: unknown } | undefined;
  return !(payload !== null && typeof payload === "object" &&
    payload.done === false);
}
