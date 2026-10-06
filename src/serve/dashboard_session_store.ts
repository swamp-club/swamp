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
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

/** An absolute lifetime bounds inactive dashboard-session coordination data. */
export const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_DASHBOARD_SESSIONS = 10_000;

const DashboardSessionSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  tokenName: z.string().min(1),
  tokenCreatedAt: z.string().datetime(),
  origin: z.string().url(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
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

  constructor(
    store: ControlPlaneStore,
    options?: ControlPlaneDashboardSessionStoreOptions,
  ) {
    this.#store = store;
    this.#now = options?.now ?? Date.now;
    this.#ttlMs = options?.ttlMs ?? DASHBOARD_SESSION_TTL_MS;
    this.#capacity = options?.capacity ?? MAX_DASHBOARD_SESSIONS;
  }

  async create(
    identity: DashboardSessionIdentity,
    origin: string,
  ): Promise<DashboardSession> {
    const active = await this.#removeExpired();
    if (active >= this.#capacity) throw new DashboardSessionCapacityError();

    const now = this.#now();
    const session: DashboardSession = {
      id: generateOpaqueToken(),
      tokenName: identity.tokenName,
      tokenCreatedAt: identity.tokenCreatedAt,
      origin,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#ttlMs).toISOString(),
    };
    const data = new TextEncoder().encode(JSON.stringify(session));
    if (this.#store.putIfAbsent) {
      const created = await this.#store.putIfAbsent(
        this.#key(session.id),
        data,
      );
      if (!created) return await this.create(identity, origin);
    } else {
      await this.#store.put(this.#key(session.id), data);
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
      await this.#store.delete(key);
      return null;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(id)) return;
    await this.#store.delete(this.#key(id));
  }

  async #removeExpired(): Promise<number> {
    const keys = await this.#store.list(SESSION_KEY_PREFIX);
    let active = 0;
    for (const key of keys) {
      const id = key.slice(SESSION_KEY_PREFIX.length);
      if (await this.get(id)) active++;
    }
    return active;
  }

  #key(id: string): string {
    return `${SESSION_KEY_PREFIX}${id}`;
  }
}
