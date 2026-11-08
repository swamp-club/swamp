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
import { join } from "@std/path";
import { TelemetryService } from "../../domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../persistence/json_telemetry_repository.ts";
import { JsonTelemetryFlushRecordRepository } from "../persistence/json_telemetry_flush_record_repository.ts";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { runTelemetrySenderMain } from "./telemetry_sender_main.ts";
import {
  claimSenderLock,
  SENDER_LOCK_FILE,
  senderArgs,
} from "./telemetry_sender_process.ts";

const INGEST = "http://ingest.test";

async function withIngest(
  respond: (req: Request) => Promise<Response>,
  fn: (url: string, received: unknown[]) => Promise<void>,
): Promise<void> {
  const received: unknown[] = [];
  await withMockedFetch(async (req) => {
    received.push(await req.clone().json());
    return await respond(req);
  }, () => fn(INGEST, received));
}

async function spoolEntry(dir: string, endpoint: string): Promise<void> {
  await new TelemetryService(
    new JsonTelemetryRepository(dir, dir),
    "1.0.0",
    undefined,
    undefined,
    undefined,
    undefined,
    endpoint,
  ).recordSuccess(
    { command: "version", args: [], optionKeys: [], globalOptions: [] },
    new Date(),
  );
}

async function withSpool(
  endpoint: string,
  count: number,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-telemetry-main-" });
  try {
    for (let i = 0; i < count; i++) await spoolEntry(dir, endpoint);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const deps = (dir: string) => ({
  telemetryDir: dir,
  userId: () => Promise.resolve("user-1"),
  authToken: () => Promise.resolve(undefined),
  lingerMs: 0,
});

/** a clock that only moves when the sender sleeps; each sleep runs onSleep */
function lingerDeps(
  dir: string,
  onSleep: (sleeps: number) => Promise<void>,
) {
  let clock = 0;
  let sleeps = 0;
  return {
    ...deps(dir),
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

interface Event {
  readonly insert_id: string;
}

function sentIds(received: unknown[]): string[] {
  return received.flatMap((body) => {
    const sent = body as Event | { events: Event[] };
    return "events" in sent
      ? sent.events.map((event) => event.insert_id)
      : [sent.insert_id];
  });
}

Deno.test("runTelemetrySenderMain: the spooled entries reach the ingest, then the lock is free (swamp-club#4457)", async () => {
  await withIngest(
    () => Promise.resolve(new Response(null, { status: 202 })),
    async (url, received) => {
      await withSpool(url, 30, async (dir) => {
        const lock = join(dir, SENDER_LOCK_FILE);
        const token = await claimSenderLock(lock);
        assert(token !== undefined);
        const args = senderArgs(token, {
          endpoint: url,
          userAgent: "swamp-cli/test",
          keepFlushed: false,
        });
        assertEquals(await runTelemetrySenderMain(args, deps(dir)), 0);
        assertEquals(new Set(sentIds(received)).size, 30);
        const record = await new JsonTelemetryFlushRecordRepository(dir)
          .read();
        assertEquals(record?.lastAttemptOk, true);
        assert(await claimSenderLock(lock) !== undefined);
      });
    },
  );
});

Deno.test("runTelemetrySenderMain: a sender that does not hold the lock sends nothing", async () => {
  await withIngest(
    () => Promise.resolve(new Response(null, { status: 202 })),
    async (url, received) => {
      await withSpool(url, 3, async (dir) => {
        await claimSenderLock(join(dir, SENDER_LOCK_FILE));
        const args = senderArgs("someone-else", {
          endpoint: url,
          userAgent: "swamp-cli/test",
          keepFlushed: false,
        });
        assertEquals(await runTelemetrySenderMain(args, deps(dir)), 0);
        assertEquals(received.length, 0);
      });
    },
  );
});

Deno.test("runTelemetrySenderMain: an ingest that never answers is given up on per request, and the lock is freed", async () => {
  await withIngest(
    // answers only by failing once the sender gives up on it
    (req) =>
      new Promise<Response>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(req.signal.reason));
      }),
    async (url) => {
      await withSpool(url, 3, async (dir) => {
        const lock = join(dir, SENDER_LOCK_FILE);
        const token = await claimSenderLock(lock);
        assert(token !== undefined);
        await runTelemetrySenderMain(
          senderArgs(token, {
            endpoint: url,
            userAgent: "swamp-cli/test",
            keepFlushed: false,
          }),
          { ...deps(dir), requestTimeoutMs: 200 },
        );
        const record = await new JsonTelemetryFlushRecordRepository(dir)
          .read();
        assertEquals(record?.lastAttemptOk, false);
        assert(await claimSenderLock(lock) !== undefined);
      });
    },
  );
});

Deno.test("runTelemetrySenderMain: entries later commands spool while the sender lingers reach the ingest through the same sender", async () => {
  await withIngest(
    () => Promise.resolve(new Response(null, { status: 202 })),
    async (url, received) => {
      await withSpool(url, 3, async (dir) => {
        const lock = join(dir, SENDER_LOCK_FILE);
        const token = await claimSenderLock(lock);
        assert(token !== undefined);
        const lingering = lingerDeps(dir, async (sleeps) => {
          if (sleeps === 5 || sleeps === 20) await spoolEntry(dir, url);
          // A command ending now finds the lock held and starts no sender.
          if (sleeps === 5) {
            assertEquals(await claimSenderLock(lock), undefined);
          }
        });

        await runTelemetrySenderMain(
          senderArgs(token, {
            endpoint: url,
            userAgent: "swamp-cli/test",
            keepFlushed: false,
          }),
          lingering,
        );

        assertEquals(new Set(sentIds(received)).size, 5);
        // idle for the full linger after the last entry, then it exits
        assertEquals(lingering.sleeps(), 20 + 30);
        assert(await claimSenderLock(lock) !== undefined);
      });
    },
  );
});

Deno.test("runTelemetrySenderMain: a lingering sender that loses its lock stops sending", async () => {
  await withIngest(
    () => Promise.resolve(new Response(null, { status: 202 })),
    async (url, received) => {
      await withSpool(url, 2, async (dir) => {
        const lock = join(dir, SENDER_LOCK_FILE);
        const token = await claimSenderLock(lock);
        assert(token !== undefined);
        const lingering = lingerDeps(dir, async (sleeps) => {
          if (sleeps !== 3) return;
          await Deno.writeTextFile(lock, "another-sender");
          await spoolEntry(dir, url);
        });

        await runTelemetrySenderMain(
          senderArgs(token, {
            endpoint: url,
            userAgent: "swamp-cli/test",
            keepFlushed: false,
          }),
          lingering,
        );

        assertEquals(new Set(sentIds(received)).size, 2);
        assertEquals(lingering.sleeps(), 3);
        assertEquals(await Deno.readTextFile(lock), "another-sender");
      });
    },
  );
});
