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

import { runDetached } from "../infrastructure/tracing/mod.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "heartbeat"]);

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_STALE_TTL_MS = 90_000;
/**
 * How long a stop waits for the write of its stopped record. The record is
 * written when the datastore was too slow for the shutdown push, so it may
 * be slow for this write too; the last periodic record is left either way.
 */
export const STOPPED_HEARTBEAT_WRITE_TIMEOUT_MS = 5_000;

export interface HeartbeatRecord {
  instanceId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  address?: string;
  /**
   * How long after `heartbeatAt` this instance asks to be counted dead. A
   * reader that cannot know the instance's settings, such as a local
   * command, goes by it.
   */
  staleTtlMs?: number;
  /**
   * When the instance stopped. A stopped record is dead at once: an
   * instance that stopped without pushing its interrupted runs leaves one
   * instead of deleting its heartbeat, so a peer reconciles it
   * (swamp-club#3958).
   */
  stoppedAt?: string;
}

export class InstanceHeartbeatService {
  readonly #store: ControlPlaneStore;
  readonly #instanceId: string;
  readonly #hostname: string;
  readonly #pid: number;
  readonly #startedAt: string;
  readonly #intervalMs: number;
  readonly #address: string | undefined;
  readonly #staleTtlMs: number | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: ControlPlaneStore,
    instanceId: string,
    options?: { intervalMs?: number; address?: string; staleTtlMs?: number },
  ) {
    this.#store = store;
    this.#instanceId = instanceId;
    this.#hostname = Deno.hostname();
    this.#pid = Deno.pid;
    this.#startedAt = new Date().toISOString();
    this.#intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#address = options?.address;
    this.#staleTtlMs = options?.staleTtlMs;
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  async start(): Promise<void> {
    if (this.#timer !== null) return;
    await this.#write();
    this.#timer = runDetached(() =>
      setInterval(() => {
        this.#write().catch((err) => {
          logger.warn("Heartbeat write failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.#intervalMs)
    );
    Deno.unrefTimer(this.#timer);
  }

  /**
   * Stops the heartbeat and deletes its record, or with `leaveStoppedRecord`
   * writes a stopped one in its place. A stopped record that cannot be
   * written in {@link STOPPED_HEARTBEAT_WRITE_TIMEOUT_MS} is logged, and the
   * last periodic record is left to go stale: never deleted.
   */
  async stop(
    options: { leaveStoppedRecord?: boolean; writeTimeoutMs?: number } = {},
  ): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (options.leaveStoppedRecord) {
      await this.#writeStopped(
        options.writeTimeoutMs ?? STOPPED_HEARTBEAT_WRITE_TIMEOUT_MS,
      );
      return;
    }
    try {
      await this.#store.delete(`heartbeats/${this.#instanceId}`);
    } catch (err) {
      logger.warn("Heartbeat delete on shutdown failed: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #writeStopped(timeoutMs: number): Promise<void> {
    const write = this.#write(new Date().toISOString());
    // Handled here as well, so a write that outlives the bound never
    // rejects unhandled.
    write.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([write, deadline]);
    } catch (err) {
      logger.warn(
        "Stopped heartbeat write on shutdown failed; the last heartbeat is left to go stale: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #write(stoppedAt?: string): Promise<void> {
    const record: HeartbeatRecord = {
      instanceId: this.#instanceId,
      hostname: this.#hostname,
      pid: this.#pid,
      startedAt: this.#startedAt,
      heartbeatAt: new Date().toISOString(),
      ...(this.#address !== undefined ? { address: this.#address } : {}),
      ...(this.#staleTtlMs !== undefined
        ? { staleTtlMs: this.#staleTtlMs }
        : {}),
      ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    };
    await this.#store.put(
      `heartbeats/${this.#instanceId}`,
      new TextEncoder().encode(JSON.stringify(record)),
    );
  }

  /** Whether `record` was left by an instance that stopped. */
  static isStopped(record: HeartbeatRecord): boolean {
    return record.stoppedAt !== undefined;
  }

  static isStale(
    record: HeartbeatRecord,
    ttlMs = DEFAULT_STALE_TTL_MS,
  ): boolean {
    if (InstanceHeartbeatService.isStopped(record)) return true;
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
        typeof parsed.heartbeatAt === "string" &&
        (parsed.address === undefined ||
          typeof parsed.address === "string") &&
        (parsed.stoppedAt === undefined ||
          typeof parsed.stoppedAt === "string")
      ) {
        return parsed as HeartbeatRecord;
      }
      return null;
    } catch {
      return null;
    }
  }
}
