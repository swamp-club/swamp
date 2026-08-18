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

import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "heartbeat"]);

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_STALE_TTL_MS = 90_000;

export interface HeartbeatRecord {
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  address?: string;
}

export class InstanceHeartbeatService {
  readonly #store: ControlPlaneStore;
  readonly #instanceId: string;
  readonly #hostname: string;
  readonly #pid: number;
  readonly #startedAt: string;
  readonly #intervalMs: number;
  readonly #address: string | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: ControlPlaneStore,
    instanceId: string,
    options?: { intervalMs?: number; address?: string },
  ) {
    this.#store = store;
    this.#instanceId = instanceId;
    this.#hostname = Deno.hostname();
    this.#pid = Deno.pid;
    this.#startedAt = new Date().toISOString();
    this.#intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#address = options?.address;
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  async start(): Promise<void> {
    if (this.#timer !== null) return;
    await this.#write();
    this.#timer = setInterval(() => {
      this.#write().catch((err) => {
        logger.warn("Heartbeat write failed: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.#intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    try {
      await this.#store.delete(`heartbeats/${this.#instanceId}`);
    } catch (err) {
      logger.warn("Heartbeat delete on shutdown failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #write(): Promise<void> {
    const record: HeartbeatRecord = {
      instanceId: this.#instanceId,
      hostname: this.#hostname,
      pid: this.#pid,
      startedAt: this.#startedAt,
      heartbeatAt: new Date().toISOString(),
      ...(this.#address !== undefined ? { address: this.#address } : {}),
    };
    await this.#store.put(
      `heartbeats/${this.#instanceId}`,
      new TextEncoder().encode(JSON.stringify(record)),
    );
  }

  static isStale(
    record: HeartbeatRecord,
    ttlMs = DEFAULT_STALE_TTL_MS,
  ): boolean {
    const heartbeatTime = new Date(record.heartbeatAt).getTime();
    if (isNaN(heartbeatTime)) return true;
    return Date.now() - heartbeatTime > ttlMs;
  }

  static parseRecord(data: Uint8Array): HeartbeatRecord | null {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data));
      if (
        typeof parsed.instanceId === "string" &&
        typeof parsed.hostname === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.heartbeatAt === "string"
      ) {
        return parsed as HeartbeatRecord;
      }
      return null;
    } catch {
      return null;
    }
  }
}
