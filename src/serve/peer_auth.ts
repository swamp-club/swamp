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
 * How a serve follower proves to its team's leader that it is a node of the
 * team, to read the leader's whole commit feed (swamp-club#4120).
 *
 * The team shares one random peer key per namespace, kept in serve's
 * encrypted control-plane vault (the token-secrets store, so a serve.yaml
 * `token-secrets` key protects it as it protects token secrets). A follower
 * presents it as the bearer token `swamp-peer.<key>` on its feed socket.
 * The key gives no identity: a peer socket may only subscribe to the commit
 * feed and ask its head, it skips the per-caller grant filter but keeps the
 * namespace one, and every other request on it is refused. It is never
 * accepted on any HTTP surface: there it is an unknown token. So a peer can
 * read only what read access to the datastore already gives, and never act
 * as a caller.
 *
 * @module
 */

import { timingSafeEqual } from "../domain/crypto/timing_safe_equal.ts";
import {
  type ServeLeader,
  serveLeaderProofText,
} from "../domain/datastore_v3/serve_leader.ts";
import type { VaultProvider } from "../domain/vaults/vault_provider.ts";

/** What a peer's bearer token starts with. */
export const PEER_TOKEN_PREFIX = "swamp-peer.";

/** The control-plane vault secret the team's peer key is kept under. */
export const PEER_KEY_SECRET = "serve-team-peer-key";

/** The only requests a peer socket may send. */
export const PEER_REQUESTS: ReadonlySet<string> = new Set([
  "server.version",
  "commits.subscribe",
  "commits.head",
]);

const PEER_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Whether `token` is a peer's, not a caller's. */
export function isPeerToken(token: string): boolean {
  return token.startsWith(PEER_TOKEN_PREFIX);
}

/** The team's peer key, read from the vault on each use. */
export class TeamPeerKey {
  readonly #vault: VaultProvider;
  readonly #now: () => number;
  /** The key last read, for {@link verify} and {@link trusts}. */
  #cached: { key: string; at: number } | undefined;
  /** When the vault was last read, what the read found, and which read. */
  #lastRead:
    | { at: number; found: "key" | "none" | "failed"; read: number }
    | undefined;
  /** Reads started, so a slow read never overwrites a newer one's answer. */
  #reads = 0;
  /** The read {@link verify} and {@link trusts} are waiting on. */
  #reading: Promise<string | undefined> | undefined;

  constructor(vault: VaultProvider, now: () => number = Date.now) {
    this.#vault = vault;
    this.#now = now;
  }

  /**
   * The key, made only when the vault holds none: a read that fails is
   * thrown, never taken as "no key", so a passing vault error cannot
   * replace the team's key. Read back after a write: two nodes that make one
   * at once agree on whichever landed last, and a leader whose proof no
   * longer holds signs its record again.
   */
  async current(): Promise<string> {
    const existing = await this.#read();
    if (existing !== undefined) return existing;
    await this.#vault.put(
      PEER_KEY_SECRET,
      Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    const made = await this.#read();
    if (made === undefined) {
      throw new Error("The team peer key could not be stored");
    }
    return made;
  }

  /** The bearer token a follower presents to the leader's feed. */
  async token(): Promise<string> {
    return `${PEER_TOKEN_PREFIX}${await this.current()}`;
  }

  /**
   * Whether `token` carries the team's key, compared in constant time. The
   * vault is read at most every {@link PEER_KEY_CACHE_MS}, whether the read
   * finds the key, finds none or fails, and checks made while a read is
   * running wait for it, so failed upgrades cannot each cost a vault read
   * (swamp-club#4153).
   */
  async verify(token: string): Promise<boolean> {
    if (!isPeerToken(token)) return false;
    const key = await this.#known();
    if (key === undefined) return false;
    return timingSafeEqual(token.slice(PEER_TOKEN_PREFIX.length), key);
  }

  /** The proof a leader record carries: an HMAC of it under the key. */
  async prove(leader: ServeLeader): Promise<string> {
    return await hmacHex(await this.current(), serveLeaderProofText(leader));
  }

  /** Whether `leader` carries the proof the team's key makes. */
  async trusts(leader: ServeLeader): Promise<boolean> {
    if (leader.proof === undefined) return false;
    const key = await this.#known();
    if (key === undefined) return false;
    return timingSafeEqual(
      leader.proof,
      await hmacHex(key, serveLeaderProofText(leader)),
    );
  }

  /**
   * Whether `header`, a follower's forwarding header, carries the team's
   * key, checked against the key this node last read, without reading the
   * vault (swamp-club#4148): the request path keys its limits on it. A node
   * that holds no usable key trusts no header.
   */
  verifyCached(header: string): boolean {
    const key = this.#usableCached();
    if (key === undefined || !isPeerToken(header)) return false;
    return timingSafeEqual(header.slice(PEER_TOKEN_PREFIX.length), key);
  }

  /** The peer token from the key this node last read, if still usable. */
  cachedToken(): string | undefined {
    const key = this.#usableCached();
    return key === undefined ? undefined : `${PEER_TOKEN_PREFIX}${key}`;
  }

  /**
   * The key, from the last read while it is recent; undefined when unread or
   * when the vault held none. A cached key outlives a failed read by at most
   * {@link PEER_KEY_STALE_MS} (swamp-club#4148), so a key deleted while the
   * vault is failing stops verifying. A node that last found no key trusts
   * nothing until its next read, at most {@link PEER_KEY_CACHE_MS} later.
   */
  async #known(): Promise<string | undefined> {
    const last = this.#lastRead;
    if (last !== undefined && this.#now() - last.at < PEER_KEY_CACHE_MS) {
      return last.found === "none" ? undefined : this.#usableCached();
    }
    this.#reading ??= this.#refresh();
    return await this.#reading;
  }

  /** One read for every check waiting on it; a failure falls back. */
  async #refresh(): Promise<string | undefined> {
    try {
      return await this.#read();
    } catch {
      return this.#usableCached();
    } finally {
      this.#reading = undefined;
    }
  }

  #usableCached(): string | undefined {
    const cached = this.#cached;
    if (cached === undefined) return undefined;
    return this.#now() - cached.at < PEER_KEY_CACHE_MS + PEER_KEY_STALE_MS
      ? cached.key
      : undefined;
  }

  /**
   * The key the vault holds, or undefined when it holds none. Any other
   * failure, and a value that is not a key, is thrown: the key is never
   * replaced because it could not be read. What it found is recorded unless
   * a read that started later already answered.
   */
  async #read(): Promise<string | undefined> {
    const read = ++this.#reads;
    try {
      const key = await this.#readKey();
      this.#record(read, key === undefined ? "none" : "key", key);
      return key;
    } catch (error) {
      this.#record(read, "failed");
      throw error;
    }
  }

  #record(
    read: number,
    found: "key" | "none" | "failed",
    key?: string,
  ): void {
    if (this.#lastRead !== undefined && this.#lastRead.read > read) return;
    const at = this.#now();
    if (key !== undefined) this.#cached = { key, at };
    this.#lastRead = { at, found, read };
  }

  async #readKey(): Promise<string | undefined> {
    let value: string;
    try {
      value = await this.#vault.get(PEER_KEY_SECRET);
    } catch (error) {
      if ((await this.#vault.list()).includes(PEER_KEY_SECRET)) throw error;
      return undefined;
    }
    const key = value.trim();
    if (!PEER_KEY_PATTERN.test(key)) {
      throw new Error("The team peer key in the vault is not a valid key");
    }
    return key;
  }
}

/** How long a read peer key is used before it is read again. */
export const PEER_KEY_CACHE_MS = 10_000;

/** How long a cached key outlives its refresh window while reads fail. */
export const PEER_KEY_STALE_MS = 60_000;

/**
 * The header a follower adds to everything it forwards to the leader, with
 * the team's peer token (swamp-club#4148). A leader that verifies it keys
 * the request's limits and audit on the caller address the follower set.
 */
export const TEAM_PEER_HEADER = "x-swamp-team-peer";

const peerSockets = new WeakSet<WebSocket>();

/** Marks `socket` as a team peer's, authenticated by the peer key. */
export function markPeerSocket(socket: WebSocket): void {
  peerSockets.add(socket);
}

/** Whether `socket` is a team peer's. */
export function isPeerSocket(socket: WebSocket): boolean {
  return peerSockets.has(socket);
}

async function hmacHex(key: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(text),
  );
  return Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The address a request to serve is limited and audited by. Behind a
 * trusted proxy (`--trust-proxy`), the first `X-Forwarded-For` entry. A
 * request a team follower forwarded, whose {@link TEAM_PEER_HEADER} the
 * peer key verifies, the last entry: the caller's address as the follower
 * set it (swamp-club#4148). Otherwise the socket peer's.
 */
export function requestClientAddress(
  headers: Headers,
  socketPeer: string,
  trustProxy: boolean,
  verifyPeer: (header: string) => boolean,
): string {
  const forwarded = headers.get("x-forwarded-for");
  if (trustProxy) return forwarded?.split(",")[0]?.trim() || socketPeer;
  const peer = headers.get(TEAM_PEER_HEADER);
  if (peer !== null && verifyPeer(peer)) {
    return forwarded?.split(",").at(-1)?.trim() || socketPeer;
  }
  return socketPeer;
}

/**
 * `req` without {@link TEAM_PEER_HEADER}, once its client address is taken:
 * no handler, payload, hook or record downstream ever sees the team's peer
 * token (swamp-club#4148). A request without the header is returned as is.
 */
export function withoutTeamPeerHeader(req: Request): Request {
  if (!req.headers.has(TEAM_PEER_HEADER)) return req;
  const headers = new Headers(req.headers);
  headers.delete(TEAM_PEER_HEADER);
  return new Request(req, { headers });
}
