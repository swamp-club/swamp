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

import { assert, assertEquals } from "@std/assert";
import { type Span, trace } from "@opentelemetry/api";
import { waitFor } from "@swamp-club/swamp-testing";
import { DaemonTelemetryFlushService } from "./telemetry_flush.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { TelemetryEntry } from "../domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../domain/telemetry/repositories.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../domain/telemetry/telemetry_sender.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../infrastructure/tracing/span_test_helpers.ts";

class FakeRepository implements TelemetryRepository {
  entries: TelemetryEntry[] = [];
  quarantined: TelemetryEntry[] = [];
  prunedFlushedBefore: Date | null = null;
  prunedQuarantinedBefore: Date | null = null;
  deleteAllCalled = false;
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

  assertEquals(repo.entries.length, 1);
});

Deno.test("DaemonTelemetryFlushService: an entry that cannot be marked is not re-sent", async () => {
  // markFlushed failing leaves the entry on disk, so without the skip set it
  // would be re-sent every tick; counts sends across several flushes
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
  // one permanently rejected entry would block every newer entry behind it;
  // asserts the healthy entries ship, since head-of-line blocking throws no
  // error
  const repo = new FakeRepository();
  const sender = new FakeSender();
  repo.entries.push(entry("poison"));
  repo.entries.push(entry("healthy-1"));
  repo.entries.push(entry("healthy-2"));
  sender.rejectIds.add("poison");

  const service = build(repo, sender);

  for (let i = 0; i < 10; i++) await service.stop();

  assertEquals(repo.quarantined.map((e) => e.id), ["poison"]);
  assertEquals(sender.countOf("healthy-1") > 0, true);
  assertEquals(sender.countOf("healthy-2") > 0, true);
  assertEquals(repo.entries.length, 0);
});

Deno.test("DaemonTelemetryFlushService: never applies the hard retention cap", async () => {
  // the daemon prunes only delivered and quarantined entries; the hard cap
  // would destroy undelivered telemetry that is still sendable
  const repo = new FakeRepository();
  const sender = new FakeSender();
  const service = build(repo, sender);

  await service.stop();

  assertEquals(repo.deleteAllCalled, false);
});

Deno.test("DaemonTelemetryFlushService: stop() awaits an in-flight timer drain before its own", async () => {
  // a timer-triggered drain is in progress when stop() is called; stop() must
  // wait for it rather than resolve while it still runs
  const repo = new FakeRepository();
  const sender = new FakeSender();

  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  let sendCalls = 0;
  const originalSendBatch = sender.sendBatch.bind(sender);
  sender.sendBatch = async (entries: TelemetryEntry[]) => {
    sendCalls++;
    if (sendCalls === 1) await gate;
    return originalSendBatch(entries);
  };

  repo.entries.push(entry("before-stop"));

  const service = new DaemonTelemetryFlushService(
    new TelemetryService(repo, "1.0.0"),
    { sender, distinctId: "user-1", keepFlushed: false },
    { intervalMs: 1 },
  );

  service.start();
  while (sendCalls === 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  repo.entries.push(entry("during-drain"));

  let stopDone = false;
  const stopPromise = service.stop().then(() => {
    stopDone = true;
  });

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(
    stopDone,
    false,
    "stop() must not resolve while drain is in-flight",
  );

  resolveGate();
  await stopPromise;

  assertEquals(stopDone, true);
  assertEquals(sender.countOf("before-stop"), 1);
  assertEquals(sender.countOf("during-drain"), 1);
  assertEquals(repo.entries.length, 0);
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

Deno.test("DaemonTelemetryFlushService: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    let recording = true;
    const repo = new FakeRepository();
    const findUnflushed = repo.findUnflushed.bind(repo);
    repo.findUnflushed = (limit) => {
      if (recording) seen.push(trace.getActiveSpan());
      return findUnflushed(limit);
    };
    const service = new DaemonTelemetryFlushService(
      new TelemetryService(repo, "1.0.0"),
      { sender: new FakeSender(), distinctId: "user-1", keepFlushed: false },
      { intervalMs: 10 },
    );
    await withSpan("swamp.cli", {}, async () => {
      service.start();
      try {
        await waitFor(() => seen.length >= 2, "two flush ticks");
      } finally {
        recording = false;
        await service.stop();
      }
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});
