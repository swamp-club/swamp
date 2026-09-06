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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { AuditWal } from "./audit_wal.ts";
import { createAuditEvent } from "./audit_event.ts";

await initializeLogging({});
import type { AuditEvent } from "./audit_event.ts";

function withTempDir(
  fn: (dir: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "audit-wal-test-" });
    try {
      await fn(dir);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  };
}

function makeEvent(action: string): AuditEvent {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

Deno.test(
  "AuditWal: initialize creates directory if missing",
  withTempDir(async (dir) => {
    const walDir = join(dir, "wal");
    const wal = new AuditWal({ dir: walDir });
    await wal.initialize();

    const stat = await Deno.stat(walDir);
    assertEquals(stat.isDirectory, true);
    assertEquals(wal.segmentCount, 0);
    assertEquals(wal.totalBytes, 0);
  }),
);

Deno.test(
  "AuditWal: append creates segment file",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const segmentName = await wal.append([makeEvent("test")]);

    assertEquals(segmentName.endsWith(".wal.jsonl"), true);
    assertEquals(wal.segmentCount, 1);

    const stat = await Deno.stat(join(dir, segmentName));
    assertEquals(stat.isFile, true);
  }),
);

Deno.test(
  "AuditWal: append rejects empty event list",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    await assertRejects(
      () => wal.append([]),
      Error,
      "Cannot append empty event list",
    );
  }),
);

Deno.test(
  "AuditWal: readSegment round-trips events",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const events = [makeEvent("a"), makeEvent("b")];
    const segmentName = await wal.append(events);
    const read = await wal.readSegment(segmentName);

    assertEquals(read.length, 2);
    assertEquals(read[0].action, "a");
    assertEquals(read[1].action, "b");
  }),
);

Deno.test(
  "AuditWal: readSegment handles partial lines gracefully",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const segmentName = await wal.append([makeEvent("valid")]);
    const path = join(dir, segmentName);
    const existing = await Deno.readFile(path);
    const partial = new TextEncoder().encode('{"truncated": true');
    const combined = new Uint8Array(existing.length + partial.length);
    combined.set(existing, 0);
    combined.set(partial, existing.length);
    await Deno.writeFile(path, combined);

    const read = await wal.readSegment(segmentName);
    assertEquals(read.length, 1);
    assertEquals(read[0].action, "valid");
  }),
);

Deno.test(
  "AuditWal: deleteSegment removes file and updates totals",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const segmentName = await wal.append([makeEvent("delete-me")]);
    assertEquals(wal.segmentCount, 1);
    const bytesBefore = wal.totalBytes;

    await wal.deleteSegment(segmentName);

    assertEquals(wal.segmentCount, 0);
    assertEquals(wal.totalBytes, bytesBefore > 0 ? 0 : 0);

    const segments = wal.listSegments();
    assertEquals(segments.length, 0);
  }),
);

Deno.test(
  "AuditWal: deleteSegment is idempotent for missing files",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    await wal.deleteSegment("nonexistent.wal.jsonl");
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "AuditWal: listSegments returns all segments in order",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const s1 = await wal.append([makeEvent("first")]);
    const s2 = await wal.append([makeEvent("second")]);

    const segments = wal.listSegments();
    assertEquals(segments.length, 2);
    assertEquals(segments[0], s1);
    assertEquals(segments[1], s2);
  }),
);

Deno.test(
  "AuditWal: initialize discovers existing segments",
  withTempDir(async (dir) => {
    const wal1 = new AuditWal({ dir });
    await wal1.initialize();
    await wal1.append([makeEvent("persisted")]);

    const wal2 = new AuditWal({ dir });
    await wal2.initialize();

    assertEquals(wal2.segmentCount, 1);
    assertEquals(wal2.totalBytes > 0, true);

    const events = await wal2.readSegment(wal2.listSegments()[0]);
    assertEquals(events[0].action, "persisted");
  }),
);

Deno.test(
  "AuditWal: enforces max WAL size by dropping oldest segments",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir, maxWalBytes: 1500 });
    await wal.initialize();

    // Append segments and track which ones survive
    const s1 = await wal.append([makeEvent("first")]);
    const bytesPerSegment = wal.totalBytes;
    await wal.append([makeEvent("second")]);
    await wal.append([makeEvent("third")]);
    await wal.append([makeEvent("fourth")]);

    // With 1500 byte limit and ~450-500 bytes per segment,
    // we expect ~3 segments to fit, oldest evicted
    const segments = wal.listSegments();
    assertEquals(segments.includes(s1), false);
    assertEquals(wal.totalBytes <= 1500 + bytesPerSegment, true);
    assertEquals(segments.length >= 1, true);
  }),
);

Deno.test(
  "AuditWal: isFull reflects capacity status",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir, maxWalBytes: 100 });
    await wal.initialize();

    assertEquals(wal.isFull, false);

    await wal.append([makeEvent("fill")]);
    // A single event's JSONL is likely > 100 bytes
    assertEquals(wal.isFull, true);
  }),
);

Deno.test(
  "AuditWal: saveCursors and loadCursors round-trip",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    await wal.saveCursors({
      cursors: { "store-a": "seg-001", "store-b": "seg-002" },
    });

    const loaded = await wal.loadCursors();
    assertEquals(loaded.cursors["store-a"], "seg-001");
    assertEquals(loaded.cursors["store-b"], "seg-002");
  }),
);

Deno.test(
  "AuditWal: loadCursors returns empty state when no file exists",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    const loaded = await wal.loadCursors();
    assertEquals(loaded, { cursors: {} });
  }),
);

Deno.test(
  "AuditWal: totalBytes tracks across appends and deletes",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    assertEquals(wal.totalBytes, 0);

    const s1 = await wal.append([makeEvent("a")]);
    const bytesAfterFirst = wal.totalBytes;
    assertEquals(bytesAfterFirst > 0, true);

    await wal.append([makeEvent("b")]);
    assertEquals(wal.totalBytes > bytesAfterFirst, true);

    await wal.deleteSegment(s1);
    assertEquals(wal.totalBytes > 0, true);
    assertEquals(wal.totalBytes < bytesAfterFirst * 2, true);
  }),
);
