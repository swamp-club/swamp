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

// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";

/**
 * Minimal AuditEvent shape for conformance testing.
 * Matches the ChainedAuditEvent contract from the serve audit domain.
 */
export interface ConformanceAuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly instanceId: string;
  readonly category: string;
  readonly stage: string;
  readonly outcome: string;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly principalKind: string;
  readonly principalId: string;
  readonly initiatedBy: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly version: 1;
  readonly sequence: number;
  readonly digest: string;
}

/**
 * The AuditSink interface that extension sinks must implement.
 */
export interface ConformanceAuditSink {
  readonly name: string;
  readonly durable: boolean;
  write(events: readonly ConformanceAuditEvent[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Options for audit sink conformance testing. */
export interface AuditSinkConformanceOptions {
  /** Factory that creates a fresh sink instance for each test. */
  factory: () => Promise<ConformanceAuditSink>;
  /** Optional cleanup to run after each test. */
  cleanup?: () => Promise<void>;
}

function makeTestEvent(sequence: number): ConformanceAuditEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    instanceId: "conformance-test",
    category: "system",
    stage: "response",
    outcome: "success",
    action: "conformance.test",
    resourceKind: "test",
    resourceName: "test-resource",
    principalKind: "system",
    principalId: "conformance",
    initiatedBy: "conformance",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
    version: 1,
    sequence,
    digest: crypto.randomUUID(),
  };
}

/**
 * Runs the audit sink conformance suite against a sink implementation.
 *
 * Registers Deno.test calls that verify the AuditSink interface contract:
 * write batches, flush, close, idempotent close, name and durable flag.
 *
 * ```typescript
 * import { assertAuditSinkConformance } from "@swamp-club/swamp-testing";
 *
 * assertAuditSinkConformance({
 *   factory: async () => new MyKafkaSink({ brokers: ["localhost:9092"] }),
 *   cleanup: async () => { /* tear down test topics *\/ },
 * });
 * ```
 */
export function assertAuditSinkConformance(
  options: AuditSinkConformanceOptions,
): void {
  const { factory, cleanup } = options;

  async function withSink(
    fn: (sink: ConformanceAuditSink) => void | Promise<void>,
  ): Promise<void> {
    const sink = await factory();
    try {
      await fn(sink);
    } finally {
      try {
        await sink.close();
      } catch {
        // best-effort cleanup
      }
      if (cleanup) await cleanup();
    }
  }

  Deno.test("AuditSink conformance: name is a non-empty string", async () => {
    await withSink((sink) => {
      assertEquals(typeof sink.name, "string");
      assert(sink.name.length > 0, "sink.name must be non-empty");
    });
  });

  Deno.test("AuditSink conformance: durable is a boolean", async () => {
    await withSink((sink) => {
      assertEquals(typeof sink.durable, "boolean");
    });
  });

  Deno.test("AuditSink conformance: write accepts a batch of events", async () => {
    await withSink(async (sink) => {
      const events = [makeTestEvent(1), makeTestEvent(2), makeTestEvent(3)];
      await sink.write(events);
    });
  });

  Deno.test("AuditSink conformance: write handles empty event array", async () => {
    await withSink(async (sink) => {
      await sink.write([]);
    });
  });

  Deno.test("AuditSink conformance: flush completes without error", async () => {
    await withSink(async (sink) => {
      const events = [makeTestEvent(1)];
      await sink.write(events);
      await sink.flush();
    });
  });

  Deno.test("AuditSink conformance: close completes without error", async () => {
    const sink = await factory();
    try {
      await sink.write([makeTestEvent(1)]);
      await sink.flush();
      await sink.close();
    } finally {
      if (cleanup) await cleanup();
    }
  });

  Deno.test("AuditSink conformance: close is idempotent", async () => {
    const sink = await factory();
    try {
      await sink.close();
      await sink.close();
    } finally {
      if (cleanup) await cleanup();
    }
  });

  Deno.test("AuditSink conformance: write after close throws or is silently ignored", async () => {
    const sink = await factory();
    try {
      await sink.close();
      try {
        await sink.write([makeTestEvent(1)]);
      } catch {
        // throwing is acceptable behavior after close
      }
    } finally {
      if (cleanup) await cleanup();
    }
  });
}
