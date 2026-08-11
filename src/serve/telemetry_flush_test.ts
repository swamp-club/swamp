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

import { assertEquals } from "@std/assert";
import { DaemonTelemetryFlushService } from "./telemetry_flush.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { TelemetryEntry } from "../domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../domain/telemetry/repositories.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../domain/telemetry/telemetry_sender.ts";

/**
 * In-memory spool that behaves like the real one: entries stay readable
 * until they are marked, and marking removes them.
 */
class FakeRepository implements TelemetryRepository {
  entries: TelemetryEntry[] = [];
  quarantined: TelemetryEntry[] = [];
  prunedFlushedBefore: Date | null = null;
  prunedQuarantinedBefore: Date | null = null;
  deleteAllCalled = false;
  /** Ids whose markFlushed reports failure, leaving them on disk. */
  unmarkableIds = new Set<string>();

  save(entry: TelemetryEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }

  findByDate(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }

  findByDateRange(): Promise<TelemetryEntry[]> {
    return Promise.resolve([]);
  }

  deleteOlderThan(date: Date): Promise<number> {
    this.prunedFlushedBefore = date;
    return Promise.resolve(0);
  }

  deleteAllOlderThan(): Promise<number> {
    this.deleteAllCalled = true;
    return Promise.resolve(0);
  }

  findUnflushed(limit: number): Promise<TelemetryEntry[]> {
    return Promise.resolve(this.entries.slice(0, limit));
  }

  markFlushed(entry: TelemetryEntry): Promise<boolean> {
    if (this.unmarkableIds.has(entry.id)) return Promise.resolve(false);
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    return Promise.resolve(true);
  }

  quarantine(entry: TelemetryEntry): Promise<void> {
    this.quarantined.push(entry);
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    return Promise.resolve();
  }

  deleteQuarantinedOlderThan(date: Date): Promise<number> {
    this.prunedQuarantinedBefore = date;
    return Promise.resolve(0);
  }
}

/** Sender that can be told to reject specific entries. */
class FakeSender implements TelemetrySender {
  sent: string[][] = [];
  rejectIds = new Set<string>();
  failEverything = false;

  sendBatch(entries: TelemetryEntry[]): Promise<TelemetryFlushResult> {
    this.sent.push(entries.map((e) => e.id));
    if (this.failEverything) {
      return Promise.resolve({ ok: false, reason: "network error" });
    }
    // A batch is all-or-nothing: one bad entry fails the whole send, which is
    // exactly what hides the offender behind its blameless neighbours.
    if (entries.some((e) => this.rejectIds.has(e.id))) {
      return Promise.resolve({ ok: false, reason: "HTTP 400" });
    }
    return Promise.resolve({ ok: true });
  }

  /** Total individual entries sent, counting re-sends. */
  totalSent(): number {
    return this.sent.reduce((sum, batch) => sum + batch.length, 0);
  }

  countOf(id: string): number {
    return this.sent.filter((batch) => batch.includes(id)).length;
  }
}

function entry(id: string): TelemetryEntry {
  return TelemetryEntry.create({
    id,
    invocation: {
      command: "workflow",
      subcommand: "run",
      args: ["<REDACTED>"],
      optionKeys: [],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt: new Date("2026-08-10T10:00:00Z"),
    completedAt: new Date("2026-08-10T10:00:05Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  });
}

function build(
  repo: FakeRepository,
  sender: FakeSender,
): DaemonTelemetryFlushService {
  return new DaemonTelemetryFlushService(
    new TelemetryService(repo, "1.0.0"),
    { sender, distinctId: "user-1", keepFlushed: false },
    { intervalMs: 60_000 },
  );
}

Deno.test("DaemonTelemetryFlushService: an empty spool makes no network call", async () => {
  const repo = new FakeRepository();
  const sender = new FakeSender();
  const service = build(repo, sender);

  await service.stop();

  assertEquals(sender.sent.length, 0);
});

Deno.test("DaemonTelemetryFlushService: drains a backlog larger than one batch", async () => {
  // flushTelemetry sends at most one batch per call, so a backlog needs
  // several within a single tick or it would take an hour to clear 100
  // entries at a 60-second cadence.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  for (let i = 0; i < 60; i++) repo.entries.push(entry(`entry-${i}`));

  await build(repo, sender).stop();

  assertEquals(repo.entries.length, 0);
  assertEquals(sender.totalSent(), 60);
});

Deno.test("DaemonTelemetryFlushService: stop() performs a final flush", async () => {
  // A draining daemon must not strand the runs it just finished.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  repo.entries.push(entry("last-run"));

  const service = build(repo, sender);
  service.start();
  await service.stop();

  assertEquals(sender.countOf("last-run"), 1);
  assertEquals(repo.entries.length, 0);
});

Deno.test("DaemonTelemetryFlushService: a send failure is swallowed and entries stay queued", async () => {
  const repo = new FakeRepository();
  const sender = new FakeSender();
  sender.failEverything = true;
  repo.entries.push(entry("kept"));

  await build(repo, sender).stop();

  // Not thrown, and not lost: the entry is still there to retry.
  assertEquals(repo.entries.length, 1);
});

Deno.test("DaemonTelemetryFlushService: an entry that cannot be marked is not re-sent", async () => {
  // markFlushed failing (a file lock, a read-only spool) leaves the entry on
  // disk, so findUnflushed keeps returning it. Without the skip set this
  // becomes a duplicate event every single tick, forever — permanent
  // inflation of the counts this whole change exists to make correct.
  // Asserted by counting sends across several flushes, not just one.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  repo.entries.push(entry("stuck"));
  repo.unmarkableIds.add("stuck");

  const service = build(repo, sender);
  await service.stop();
  await service.stop();
  await service.stop();

  assertEquals(sender.countOf("stuck"), 1);
});

Deno.test("DaemonTelemetryFlushService: a poison entry is quarantined and the queue advances", async () => {
  // findUnflushed returns the oldest entries first and a batch is only marked
  // after the whole batch sends, so one permanently-rejected entry blocks
  // every newer entry behind it. The daemon would keep flushing on schedule
  // and still deliver nothing. This asserts PROGRESS — that the healthy
  // entries behind the poison one actually ship — because head-of-line
  // blocking throws no error and would otherwise look like success.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  repo.entries.push(entry("poison"));
  repo.entries.push(entry("healthy-1"));
  repo.entries.push(entry("healthy-2"));
  sender.rejectIds.add("poison");

  const service = build(repo, sender);

  // Enough passes to exhaust the isolation threshold, then drain.
  for (let i = 0; i < 10; i++) await service.stop();

  assertEquals(repo.quarantined.map((e) => e.id), ["poison"]);
  assertEquals(sender.countOf("healthy-1") > 0, true);
  assertEquals(sender.countOf("healthy-2") > 0, true);
  assertEquals(repo.entries.length, 0);
});

Deno.test("DaemonTelemetryFlushService: never applies the hard retention cap", async () => {
  // The daemon prunes delivered and quarantined entries only. Applying the
  // hard cap would destroy undelivered telemetry that is still perfectly
  // sendable — the exact loss this issue exists to prevent.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  const service = build(repo, sender);

  await service.stop();

  assertEquals(repo.deleteAllCalled, false);
});

Deno.test("DaemonTelemetryFlushService: stop() prevents any further flushing", async () => {
  // Nothing may start a flush after shutdown begins, or it could race the
  // CLI's own teardown flush over the same spool.
  const repo = new FakeRepository();
  const sender = new FakeSender();
  const service = build(repo, sender);
  service.start();
  await service.stop();

  repo.entries.push(entry("after-stop"));
  service.start();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assertEquals(sender.countOf("after-stop"), 0);
});
