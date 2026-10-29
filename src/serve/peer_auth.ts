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

  constructor(vault: VaultProvider) {
    this.#vault = vault;
  }

  /**
   * The key, made when the team has none yet. Read back after a write: two
   * nodes that make one at once agree on whichever landed last, since every
   * use reads it again.
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

  /** Whether `token` carries the team's key, compared in constant time. */
  async verify(token: string): Promise<boolean> {
    if (!isPeerToken(token)) return false;
    const presented = token.slice(PEER_TOKEN_PREFIX.length);
    const key = await this.#read();
    if (key === undefined) return false;
    return timingSafeEqual(presented, key);
  }

  /** The proof a leader record carries: an HMAC of it under the key. */
  async prove(leader: ServeLeader): Promise<string> {
    return await hmacHex(await this.current(), serveLeaderProofText(leader));
  }

  /** Whether `leader` carries the proof the team's key makes. */
  async trusts(leader: ServeLeader): Promise<boolean> {
    if (leader.proof === undefined) return false;
    const key = await this.#read();
    if (key === undefined) return false;
    return timingSafeEqual(
      leader.proof,
      await hmacHex(key, serveLeaderProofText(leader)),
    );
  }

  async #read(): Promise<string | undefined> {
    try {
      const value = await this.#vault.get(PEER_KEY_SECRET);
      return PEER_KEY_PATTERN.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

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
