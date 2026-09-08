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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";
import type { AuditWal } from "../../domain/serve_audit/audit_wal.ts";

const logger = getSwampLogger(["serve", "audit", "wal-sink"]);

export interface WalSinkOptions {
  readonly wal: AuditWal;
  readonly downstream: AuditSink;
}

export class WalSink implements AuditSink {
  readonly name = "wal";
  readonly durable = true;
  readonly #wal: AuditWal;
  readonly #downstream: AuditSink;
  readonly #delivered = new Set<string>();

  constructor(options: WalSinkOptions) {
    this.#wal = options.wal;
    this.#downstream = options.downstream;
  }

  get wal(): AuditWal {
    return this.#wal;
  }

  async write(events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    const segmentName = await this.#wal.append(events);

    try {
      await this.#downstream.write(events);
      this.#delivered.add(segmentName);
    } catch (error: unknown) {
      logger.warn(
        "Downstream sink failed, events persisted to WAL segment {segment}: {error}",
        {
          segment: segmentName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async flush(): Promise<void> {
    let flushSucceeded = false;
    try {
      await this.#downstream.flush();
      flushSucceeded = true;
    } catch (error: unknown) {
      logger.warn("Downstream flush failed: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!flushSucceeded) return;

    const deleted: string[] = [];
    for (const segmentName of this.#delivered) {
      try {
        await this.#wal.deleteSegment(segmentName);
        deleted.push(segmentName);
      } catch (error: unknown) {
        logger.warn(
          "Failed to delete delivered WAL segment {segment}: {error}",
          {
            segment: segmentName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    for (const name of deleted) {
      this.#delivered.delete(name);
    }
  }

  async replay(): Promise<number> {
    const segments = this.#wal.listSegments();
    let replayedCount = 0;

    for (const segmentName of segments) {
      try {
        const events = await this.#wal.readSegment(segmentName);
        if (events.length === 0) {
          await this.#wal.deleteSegment(segmentName);
          continue;
        }

        await this.#downstream.write(events);
        await this.#wal.deleteSegment(segmentName);
        replayedCount += events.length;
      } catch (error: unknown) {
        logger.warn(
          "Failed to replay WAL segment {segment}, will retry later: {error}",
          {
            segment: segmentName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        break;
      }
    }

    return replayedCount;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.#downstream.close();
  }
}
