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
 * the peer key gives no identity: a peer socket may only subscribe to the
 * commit feed and ask its head, and is never accepted on HTTP, so a peer reads
 * only what datastore read access gives
 */

import { timingSafeEqual } from "../domain/crypto/timing_safe_equal.ts";
import {
  type ServeLeader,
  serveLeaderProofText,
} from "../domain/datastore_v3/serve_leader.ts";
import type { VaultProvider } from "../domain/vaults/vault_provider.ts";

export const PEER_TOKEN_PREFIX = "swamp-peer.";

export const PEER_KEY_SECRET = "serve-team-peer-key";

export const PEER_REQUESTS: ReadonlySet<string> = new Set([
  "server.version",
  "commits.subscribe",
  "commits.head",
]);

const PEER_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function isPeerToken(token: string): boolean {
  return token.startsWith(PEER_TOKEN_PREFIX);
}

export class TeamPeerKey {
  readonly #vault: VaultProvider;
  readonly #now: () => number;
  #cached: { key: string; at: number } | undefined;
  #lastRead:
    | { at: number; found: "key" | "none" | "failed"; read: number }
    | undefined;
  /** Reads started, so a slow read never overwrites a newer one's answer. */
  #reads = 0;
  #reading: { at: number; answer: Promise<string | undefined> } | undefined;

  constructor(vault: VaultProvider, now: () => number = Date.now) {
    this.#vault = vault;
    this.#now = now;
  }

  /**
   * made only when the vault holds none; a failed read is thrown, never taken
   * as no key, so a passing vault error cannot replace the team's key; read
   * back after a write so racing nodes agree
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

  async token(): Promise<string> {
    return `${PEER_TOKEN_PREFIX}${await this.current()}`;
  }

  /**
   * constant-time compare; the vault is read at most every PEER_KEY_CACHE_MS
   * and checks during a read wait for it, so failed upgrades cannot each cost a
   * vault read
   */
  async verify(token: string): Promise<boolean> {
    if (!isPeerToken(token)) return false;
    const key = await this.#known();
    if (key === undefined) return false;
    return timingSafeEqual(token.slice(PEER_TOKEN_PREFIX.length), key);
  }

  async prove(leader: ServeLeader): Promise<string> {
    return await hmacHex(await this.current(), serveLeaderProofText(leader));
  }

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
   * checked against the key last read, without reading the vault, since the
   * request path keys its limits on it; a node with no usable key trusts no
   * header
   */
  verifyCached(header: string): boolean {
    const key = this.#usableCached();
    if (key === undefined || !isPeerToken(header)) return false;
    return timingSafeEqual(header.slice(PEER_TOKEN_PREFIX.length), key);
  }

  cachedToken(): string | undefined {
    const key = this.#usableCached();
    return key === undefined ? undefined : `${PEER_TOKEN_PREFIX}${key}`;
  }

  /**
   * a cached key outlives a failed read by at most PEER_KEY_STALE_MS, so a key
   * deleted while the vault fails stops verifying; a node that found no key
   * trusts nothing until its next read
   */
  async #known(): Promise<string | undefined> {
    const last = this.#lastRead;
    if (last !== undefined && this.#now() - last.at < PEER_KEY_CACHE_MS) {
      return last.found === "none" ? undefined : this.#usableCached();
    }
    const reading = this.#reading;
    if (
      reading !== undefined && this.#now() - reading.at < PEER_KEY_CACHE_MS
    ) {
      return await reading.answer;
    }
    // A read that has not answered within the window is left to its own
    // waiters: later checks start a fresh one rather than join it for ever.
    const answer = this.#refresh().finally(() => {
      if (this.#reading?.answer === answer) this.#reading = undefined;
    });
    this.#reading = { at: this.#now(), answer };
    return await answer;
  }

  async #refresh(): Promise<string | undefined> {
    try {
      return await this.#read();
    } catch {
      return this.#usableCached();
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
   * the key is never replaced because it could not be read; a failure or a
   * non-key value is thrown; a later failure says nothing about which key is
   * current, so a newer read's answer is kept
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
    const last = this.#lastRead;
    if (last !== undefined && last.read > read && last.found !== "failed") {
      return;
    }
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

export const PEER_KEY_CACHE_MS = 10_000;

export const PEER_KEY_STALE_MS = 60_000;

/**
 * a leader that verifies it keys the request's limits and audit on the caller
 * address the follower set
 */
export const TEAM_PEER_HEADER = "x-swamp-team-peer";

const peerSockets = new WeakSet<WebSocket>();

export function markPeerSocket(socket: WebSocket): void {
  peerSockets.add(socket);
}

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
 * behind a trusted proxy the first X-Forwarded-For entry; for a verified
 * follower forward the last entry, the caller's address as the follower set it;
 * otherwise the socket peer's
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
 * no handler, payload, hook or record downstream may ever see the team's peer
 * token; a request without the header is returned as is
 */
export function withoutTeamPeerHeader(req: Request): Request {
  if (!req.headers.has(TEAM_PEER_HEADER)) return req;
  const headers = new Headers(req.headers);
  headers.delete(TEAM_PEER_HEADER);
  return new Request(req, { headers });
}
