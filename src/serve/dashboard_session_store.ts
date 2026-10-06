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

import { z } from "zod";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { generateOpaqueToken } from "../domain/remote/session_credential.ts";

const SESSION_KEY_PREFIX = "dashboard-sessions/";
const TOKEN_INDEX_PREFIX = `${SESSION_KEY_PREFIX}by-token/`;
const SLOT_KEY_PREFIX = `${SESSION_KEY_PREFIX}slots/`;
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

/** An absolute lifetime bounds inactive dashboard-session coordination data. */
export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_DASHBOARD_SESSIONS = 10_000;
export const MAX_DASHBOARD_SESSIONS_PER_TOKEN = 100;

const DashboardSessionSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  tokenName: z.string().min(1),
  tokenCreatedAt: z.string().datetime(),
  origin: z.string().url(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const DashboardSessionTokenIndexSchema = z.object({
  slot: z.number().int().nonnegative(),
});

/**
 * An opaque browser-session entity held in the control plane.
 *
 * It deliberately contains a server-token reference and mint identity, never
 * the token's bearer secret. The server-token aggregate remains the authority
 * for principal, policy snapshot, expiry, and revocation.
 */
export type DashboardSession = z.infer<typeof DashboardSessionSchema>;

export interface DashboardSessionIdentity {
  readonly tokenName: string;
  readonly tokenCreatedAt: string;
}

export interface DashboardSessionStore {
  create(
    identity: DashboardSessionIdentity,
    origin: string,
  ): Promise<DashboardSession>;
  get(id: string): Promise<DashboardSession | null>;
  delete(id: string): Promise<void>;
}

export class DashboardSessionCapacityError extends Error {
  constructor() {
    super("Dashboard session capacity is temporarily exhausted");
    this.name = "DashboardSessionCapacityError";
  }
}

export interface ControlPlaneDashboardSessionStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly capacity?: number;
  readonly maxSessionsPerToken?: number;
}

/**
 * A shared control-plane repository for dashboard sessions.
 *
 * Control-plane backends are scoped by the configured datastore namespace, so
 * every serve replica for one namespace resolves the same opaque cookie id.
 */
export class ControlPlaneDashboardSessionStore
  implements DashboardSessionStore {
  readonly #store: ControlPlaneStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #maxSessionsPerToken: number;

  constructor(
    store: ControlPlaneStore,
    options?: ControlPlaneDashboardSessionStoreOptions,
  ) {
    this.#store = store;
    this.#now = options?.now ?? Date.now;
    this.#ttlMs = options?.ttlMs ?? DASHBOARD_SESSION_TTL_MS;
    this.#capacity = options?.capacity ?? MAX_DASHBOARD_SESSIONS;
    this.#maxSessionsPerToken = options?.maxSessionsPerToken ??
      MAX_DASHBOARD_SESSIONS_PER_TOKEN;
  }

  async create(
    identity: DashboardSessionIdentity,
    origin: string,
  ): Promise<DashboardSession> {
    const now = this.#now();
    const session: DashboardSession = {
      id: generateOpaqueToken(),
      tokenName: identity.tokenName,
      tokenCreatedAt: identity.tokenCreatedAt,
      origin,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    };
    await this.#evictOverflowForToken(identity.tokenName);
    const slot = await this.#reserveSlot(session);
    if (slot === null) throw new DashboardSessionCapacityError();
    const data = new TextEncoder().encode(JSON.stringify(session));
    try {
      await this.#store.put(this.#key(session.id), data);
      await this.#store.put(
        this.#tokenIndexKey(session.tokenName, session.id),
        new TextEncoder().encode(JSON.stringify({ slot })),
      );
    } catch (error) {
      await this.#store.delete(this.#slotKey(slot));
      await this.#store.delete(this.#key(session.id));
      await this.#store.delete(
        this.#tokenIndexKey(session.tokenName, session.id),
      );
      throw error;
    }
    return session;
  }

  async get(id: string): Promise<DashboardSession | null> {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const key = this.#key(id);
    const raw = await this.#store.get(key);
    if (raw === null) return null;
    let session: DashboardSession;
    try {
      session = DashboardSessionSchema.parse(
        JSON.parse(new TextDecoder().decode(raw)),
      );
    } catch {
      await this.#store.delete(key);
      return null;
    }
    if (Date.parse(session.expiresAt) <= this.#now()) {
      await this.#deleteSession(session);
      return null;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(id)) return;
    const raw = await this.#store.get(this.#key(id));
    if (raw === null) return;
    try {
      await this.#deleteSession(
        DashboardSessionSchema.parse(JSON.parse(new TextDecoder().decode(raw))),
      );
    } catch {
      await this.#store.delete(this.#key(id));
    }
  }

  async #evictOverflowForToken(tokenName: string): Promise<void> {
    const keys = await this.#store.list(this.#tokenIndexPrefix(tokenName));
    const sessions: DashboardSession[] = [];
    const prefix = this.#tokenIndexPrefix(tokenName);
    for (const key of keys) {
      const id = key.slice(prefix.length);
      const session = await this.get(id);
      if (session === null || session.tokenName !== tokenName) {
        await this.#store.delete(key);
      } else {
        sessions.push(session);
      }
    }
    sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const overflow = sessions.length - this.#maxSessionsPerToken + 1;
    for (const session of sessions.slice(0, Math.max(0, overflow))) {
      await this.#deleteSession(session);
    }
  }

  #key(id: string): string {
    return `${SESSION_KEY_PREFIX}${id}`;
  }

  async #reserveSlot(session: DashboardSession): Promise<number | null> {
    const encoded = new TextEncoder().encode(JSON.stringify({
      id: session.id,
      expiresAt: session.expiresAt,
    }));
    const start = Number.parseInt(session.id.slice(0, 8), 16) % this.#capacity;
    for (let offset = 0; offset < this.#capacity; offset++) {
      const slot = (start + offset) % this.#capacity;
      const key = this.#slotKey(slot);
      if (this.#store.putIfAbsent) {
        if (await this.#store.putIfAbsent(key, encoded)) return slot;
        const existing = await this.#store.get(key);
        if (existing === null || !this.#isExpiredSlot(existing)) continue;
        await this.#store.delete(key);
        if (await this.#store.putIfAbsent(key, encoded)) return slot;
      } else if (await this.#store.get(key) === null) {
        await this.#store.put(key, encoded);
        return slot;
      }
    }
    return null;
  }

  #isExpiredSlot(data: Uint8Array): boolean {
    try {
      const slot = z.object({ expiresAt: z.string().datetime() }).parse(
        JSON.parse(new TextDecoder().decode(data)),
      );
      return Date.parse(slot.expiresAt) <= this.#now();
    } catch {
      return true;
    }
  }

  async #deleteSession(session: DashboardSession): Promise<void> {
    await this.#store.delete(this.#key(session.id));
    const indexKey = this.#tokenIndexKey(session.tokenName, session.id);
    const index = await this.#store.get(indexKey);
    await this.#store.delete(indexKey);
    if (index === null) return;
    try {
      const { slot } = DashboardSessionTokenIndexSchema.parse(
        JSON.parse(new TextDecoder().decode(index)),
      );
      await this.#store.delete(this.#slotKey(slot));
    } catch {
      // A malformed index can only retain a slot until its backing session TTL.
    }
  }

  #slotKey(slot: number): string {
    return `${SLOT_KEY_PREFIX}${slot}`;
  }

  #tokenIndexPrefix(tokenName: string): string {
    return `${TOKEN_INDEX_PREFIX}${this.#encodeTokenName(tokenName)}/`;
  }

  #tokenIndexKey(tokenName: string, id: string): string {
    return `${this.#tokenIndexPrefix(tokenName)}${id}`;
  }

  #encodeTokenName(tokenName: string): string {
    return Array.from(
      new TextEncoder().encode(tokenName),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  }
}
