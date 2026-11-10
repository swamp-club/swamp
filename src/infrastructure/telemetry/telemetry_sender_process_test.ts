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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { TelemetryService } from "../../domain/telemetry/telemetry_service.ts";
import type { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../../domain/telemetry/telemetry_sender.ts";
import { JsonTelemetryRepository } from "../persistence/json_telemetry_repository.ts";
import { JsonTelemetryFlushRecordRepository } from "../persistence/json_telemetry_flush_record_repository.ts";
import {
  claimSenderLock,
  drainAndLinger,
  drainTelemetrySpool,
  heartbeatSenderLock,
  hostSenderCommand,
  parseSenderArgs,
  releaseSenderLock,
  SENDER_LOCK_FILE,
  SENDER_LOCK_STALE_MS,
  SENDER_REPO_ID_ENV,
  senderArgs,
  startTelemetrySender,
  TELEMETRY_SENDER_MARKER,
} from "./telemetry_sender_process.ts";

const ENDPOINT = "http://ingest.test";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-telemetry-sender-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function serviceAt(dir: string): TelemetryService {
  return new TelemetryService(
    new JsonTelemetryRepository(dir, dir),
    "1.0.0",
    undefined,
    undefined,
    undefined,
    undefined,
    ENDPOINT,
    new JsonTelemetryFlushRecordRepository(dir),
  );
}

/** one entry per call, as each command is its own process and service */
async function spool(dir: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await serviceAt(dir).recordSuccess(
      { command: "version", args: [], optionKeys: [], globalOptions: [] },
      new Date(),
    );
  }
}

class RecordingSender implements TelemetrySender {
  readonly batches: string[][] = [];
  failAfter = Infinity;
  attempts = 0;
  sendBatch(entries: TelemetryEntry[]): Promise<TelemetryFlushResult> {
    this.attempts++;
    if (this.batches.length >= this.failAfter) {
      return Promise.resolve({ ok: false, reason: "HTTP 503" });
    }
    this.batches.push(entries.map((entry) => entry.id));
    return Promise.resolve({ ok: true });
  }
}

Deno.test("claimSenderLock: one holder at a time; a lock a dead sender left is taken over", async () => {
  await withDir(async (dir) => {
    const lock = join(dir, SENDER_LOCK_FILE);
    const first = await claimSenderLock(lock);
    assert(first !== undefined);
    assertEquals(await claimSenderLock(lock), undefined);

    const old = new Date(Date.now() - SENDER_LOCK_STALE_MS - 1_000);
    await Deno.utime(lock, old, old);
    const second = await claimSenderLock(lock);
    assert(second !== undefined && second !== first);
    assertEquals(await heartbeatSenderLock(lock, first), false);
    assertEquals(await heartbeatSenderLock(lock, second), true);

    await releaseSenderLock(lock, first);
    assertEquals(await Deno.readTextFile(lock), second);
    await releaseSenderLock(lock, second);
    assert(await claimSenderLock(lock) !== undefined);
  });
});

Deno.test("startTelemetrySender: a burst of commands starts one sender (swamp-club#4457)", async () => {
  await withDir(async (dir) => {
    const launches: { args: string[]; env: Record<string, string> }[] = [];
    const started = await Promise.all(
      Array.from({ length: 20 }, () =>
        startTelemetrySender(dir, {
          endpoint: ENDPOINT,
          userAgent: "swamp-cli/test",
          repoId: "repo-1",
          keepFlushed: false,
        }, {
          command: { command: "swamp", prefixArgs: [] },
          launch: (_command, args, env) =>
            launches.push({ args: [...args], env }),
        })),
    );
    assertEquals(started.filter((s) => s).length, 1);
    assertEquals(launches.length, 1);
    const parsed = parseSenderArgs(
      launches[0].args,
      launches[0].env[SENDER_REPO_ID_ENV],
    );
    assertEquals(parsed?.endpoint, ENDPOINT);
    assertEquals(parsed?.repoId, "repo-1");
    // an evaluated value never reaches argv, which every user can read
    assert(!launches[0].args.includes("repo-1"));
    assertEquals(
      await Deno.readTextFile(join(dir, SENDER_LOCK_FILE)),
      parsed?.token,
    );
  });
});

Deno.test("startTelemetrySender: a sender that cannot be started leaves the lock free", async () => {
  await withDir(async (dir) => {
    await assertRejects(() =>
      startTelemetrySender(dir, {
        endpoint: ENDPOINT,
        userAgent: "swamp-cli/test",
        keepFlushed: false,
      }, {
        command: { command: "swamp", prefixArgs: [] },
        launch: () => {
          throw new Error("no such binary");
        },
      })
    );
    assert(await claimSenderLock(join(dir, SENDER_LOCK_FILE)) !== undefined);
  });
});

Deno.test("hostSenderCommand: the compiled binary runs itself, deno runs the entry module", () => {
  assertEquals(hostSenderCommand("/usr/local/bin/swamp"), {
    command: "/usr/local/bin/swamp",
    prefixArgs: [],
  });
  const source = hostSenderCommand("/home/me/.deno/bin/deno");
  assertEquals(source.prefixArgs.slice(0, 2), ["run", "-A"]);
  assert(source.prefixArgs.at(-1)!.endsWith("telemetry_sender_entry.ts"));
  assertEquals(
    parseSenderArgs(senderArgs("t", {
      endpoint: ENDPOINT,
      userAgent: "ua",
      keepFlushed: true,
    }))?.keepFlushed,
    true,
  );
  assertEquals(parseSenderArgs([TELEMETRY_SENDER_MARKER]), undefined);
});

Deno.test("drainTelemetrySpool: sends the spool batch by batch until it is empty", async () => {
  await withDir(async (dir) => {
    await spool(dir, 60);
    const sender = new RecordingSender();
    const result = await drainTelemetrySpool({
      service: serviceAt(dir),
      sender,
      distinctId: "user-1",
      keepFlushed: false,
      heartbeat: () => Promise.resolve(true),
    });
    assertEquals(result, { sent: 60, ok: true });
    assertEquals(new Set(sender.batches.flat()).size, 60);
    assertEquals(await serviceAt(dir).hasUnflushed(), false);
  });
});

Deno.test("drainTelemetrySpool: stops at a failed send, and when the lock is lost", async () => {
  await withDir(async (dir) => {
    await spool(dir, 60);
    const failing = new RecordingSender();
    failing.failAfter = 1;
    assertEquals(
      await drainTelemetrySpool({
        service: serviceAt(dir),
        sender: failing,
        distinctId: "user-1",
        keepFlushed: false,
        heartbeat: () => Promise.resolve(true),
      }),
      { sent: 25, ok: false },
    );
    const lost = new RecordingSender();
    assertEquals(
      await drainTelemetrySpool({
        service: serviceAt(dir),
        sender: lost,
        distinctId: "user-1",
        keepFlushed: false,
        heartbeat: () => Promise.resolve(false),
      }),
      { sent: 0, ok: true },
    );
    assertEquals(lost.batches.length, 0);
  });
});

/** a clock that only moves when the sender sleeps; each sleep runs onSleep */
function lingerClock(
  onSleep: (sleeps: number) => Promise<void> = () => Promise.resolve(),
) {
  let clock = 0;
  let sleeps = 0;
  return {
    lingerMs: 30_000,
    pollMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
      await onSleep(++sleeps);
    },
    sleeps: () => sleeps,
  };
}

Deno.test("drainAndLinger: a failed first send keeps the lock for a linger and sends nothing more", async () => {
  await withDir(async (dir) => {
    await spool(dir, 3);
    const failing = new RecordingSender();
    failing.failAfter = 0;
    let heartbeats = 0;
    const clock = lingerClock(() => spool(dir, 1));
    await drainAndLinger({
      service: serviceAt(dir),
      sender: failing,
      distinctId: "user-1",
      keepFlushed: false,
      heartbeat: () => Promise.resolve(++heartbeats > 0),
      ...clock,
    });
    assertEquals(failing.attempts, 1);
    assertEquals(clock.sleeps(), 30);
    // one before the first batch, then one per poll of the hold
    assertEquals(heartbeats, 1 + 30);
  });
});

Deno.test("drainAndLinger: a send that fails during the linger holds the lock for a fresh linger", async () => {
  await withDir(async (dir) => {
    await spool(dir, 1);
    const sender = new RecordingSender();
    sender.failAfter = 1;
    const clock = lingerClock(async (sleeps) => {
      if (sleeps <= 10) await spool(dir, 1);
    });
    await drainAndLinger({
      service: serviceAt(dir),
      sender,
      distinctId: "user-1",
      keepFlushed: false,
      heartbeat: () => Promise.resolve(true),
      ...clock,
    });
    assertEquals(sender.batches.length, 1);
    assertEquals(sender.attempts, 2);
    assertEquals(clock.sleeps(), 1 + 30);
  });
});

Deno.test("drainAndLinger: a sender holding the lock after a failed send stops once the lock is lost", async () => {
  await withDir(async (dir) => {
    await spool(dir, 1);
    const failing = new RecordingSender();
    failing.failAfter = 0;
    let heartbeats = 0;
    const clock = lingerClock();
    await drainAndLinger({
      service: serviceAt(dir),
      sender: failing,
      distinctId: "user-1",
      keepFlushed: false,
      heartbeat: () => Promise.resolve(++heartbeats <= 4),
      ...clock,
    });
    assertEquals(failing.attempts, 1);
    assertEquals(clock.sleeps(), 4);
  });
});
