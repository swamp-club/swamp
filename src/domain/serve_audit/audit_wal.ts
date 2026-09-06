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

import { join } from "@std/path";
import type { AuditEvent } from "./audit_event.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "audit", "wal"]);

const DEFAULT_MAX_WAL_BYTES = 100 * 1024 * 1024;

export interface AuditWalOptions {
  readonly dir: string;
  readonly maxWalBytes?: number;
}

export interface WalCursorState {
  readonly cursors: Record<string, string>;
}

export class AuditWal {
  readonly #dir: string;
  readonly #maxWalBytes: number;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  #totalBytes = 0;
  #segments: string[] = [];
  #eventsDropped = false;

  constructor(options: AuditWalOptions) {
    this.#dir = options.dir;
    this.#maxWalBytes = options.maxWalBytes ?? DEFAULT_MAX_WAL_BYTES;
  }

  get dir(): string {
    return this.#dir;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get segmentCount(): number {
    return this.#segments.length;
  }

  get isFull(): boolean {
    return this.#totalBytes >= this.#maxWalBytes;
  }

  get hasDroppedEvents(): boolean {
    return this.#eventsDropped;
  }

  clearDroppedFlag(): void {
    this.#eventsDropped = false;
  }

  async initialize(): Promise<void> {
    try {
      await Deno.mkdir(this.#dir, { recursive: true });
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }

    this.#segments = [];
    this.#totalBytes = 0;

    const entries: string[] = [];
    for await (const entry of Deno.readDir(this.#dir)) {
      if (entry.isFile && entry.name.endsWith(".wal.jsonl")) {
        entries.push(entry.name);
      }
    }
    entries.sort();

    for (const name of entries) {
      const path = join(this.#dir, name);
      const stat = await Deno.stat(path);
      this.#segments.push(name);
      this.#totalBytes += stat.size;
    }
  }

  async append(events: readonly AuditEvent[]): Promise<string> {
    if (events.length === 0) {
      throw new Error("Cannot append empty event list to WAL");
    }

    const segmentName = `${Date.now()}-${crypto.randomUUID()}.wal.jsonl`;
    const path = join(this.#dir, segmentName);
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const data = this.#encoder.encode(jsonl);

    await Deno.writeFile(path, data);
    this.#segments.push(segmentName);
    this.#totalBytes += data.byteLength;

    await this.#enforceLimit();

    return segmentName;
  }

  async readSegment(segmentName: string): Promise<AuditEvent[]> {
    const path = join(this.#dir, segmentName);
    const data = await Deno.readFile(path);
    const text = this.#decoder.decode(data);
    const events: AuditEvent[] = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        // Skip partial/corrupt lines from crash recovery
      }
    }

    return events;
  }

  async deleteSegment(segmentName: string): Promise<void> {
    const path = join(this.#dir, segmentName);
    try {
      const stat = await Deno.stat(path);
      await Deno.remove(path);
      this.#totalBytes = Math.max(0, this.#totalBytes - stat.size);
    } catch (error: unknown) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#segments = this.#segments.filter((s) => s !== segmentName);
  }

  listSegments(): readonly string[] {
    return this.#segments;
  }

  async saveCursors(cursors: WalCursorState): Promise<void> {
    const path = join(this.#dir, "cursors.json");
    const data = this.#encoder.encode(JSON.stringify(cursors, null, 2));
    await Deno.writeFile(path, data);
  }

  async loadCursors(): Promise<WalCursorState> {
    const path = join(this.#dir, "cursors.json");
    try {
      const data = await Deno.readFile(path);
      return JSON.parse(this.#decoder.decode(data)) as WalCursorState;
    } catch (error: unknown) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof SyntaxError
      ) {
        if (error instanceof SyntaxError) {
          logger.warn("Corrupted cursors.json, resetting: {error}", {
            error: error.message,
          });
        }
        return { cursors: {} };
      }
      throw error;
    }
  }

  async saveChainState(
    state: { sequence: number; previousDigest: string },
  ): Promise<void> {
    const path = join(this.#dir, "chain-state.json");
    const data = this.#encoder.encode(JSON.stringify(state, null, 2));
    await Deno.writeFile(path, data);
  }

  async loadChainState(): Promise<
    { sequence: number; previousDigest: string } | null
  > {
    const path = join(this.#dir, "chain-state.json");
    try {
      const data = await Deno.readFile(path);
      return JSON.parse(this.#decoder.decode(data)) as {
        sequence: number;
        previousDigest: string;
      };
    } catch (error: unknown) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof SyntaxError
      ) {
        if (error instanceof SyntaxError) {
          logger.warn("Corrupted chain-state.json, resetting: {error}", {
            error: error.message,
          });
        }
        return null;
      }
      throw error;
    }
  }

  async #enforceLimit(): Promise<void> {
    while (this.#totalBytes > this.#maxWalBytes && this.#segments.length > 1) {
      const oldest = this.#segments[0];
      logger.warn(
        "WAL size limit exceeded, dropping oldest segment {segment} (undelivered events may be lost)",
        { segment: oldest },
      );
      this.#eventsDropped = true;
      await this.deleteSegment(oldest);
    }
  }
}
