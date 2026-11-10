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
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import type { TelemetryEntry } from "../domain/telemetry/telemetry_entry.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../domain/telemetry/telemetry_sender.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { sendTelemetryAtCommandEnd } from "./telemetry_end_of_command.ts";
import type { TelemetryContext } from "./telemetry_integration.ts";

await initializeLogging({});

class CountingSender implements TelemetrySender {
  sent = 0;
  sendBatch(entries: TelemetryEntry[]): Promise<TelemetryFlushResult> {
    this.sent += entries.length;
    return Promise.resolve({ ok: true });
  }
}

async function withSpooledContext(
  fn: (ctx: TelemetryContext) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-telemetry-end-" });
  try {
    const service = new TelemetryService(
      new JsonTelemetryRepository(dir, dir),
      "1.0.0",
      undefined,
      undefined,
      undefined,
      undefined,
      "http://ingest.test",
    );
    await service.recordSuccess(
      { command: "version", args: [], optionKeys: [], globalOptions: [] },
      new Date(),
    );
    await fn({
      service,
      userId: "user-1",
      repoId: undefined,
      telemetryEndpoint: "http://ingest.test",
      keepFlushed: false,
      authToken: null,
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("sendTelemetryAtCommandEnd: on Windows a command sends the spool itself and starts no sender (swamp-club#4457)", async () => {
  await withSpooledContext(async (ctx) => {
    let started = 0;
    const sender = new CountingSender();
    await sendTelemetryAtCommandEnd(ctx, { succeeded: true }, {
      os: "windows",
      sender,
      startSender: () => {
        started++;
        return Promise.resolve(true);
      },
    });
    assertEquals(started, 0);
    assertEquals(sender.sent, 1);
  });
});

for (const os of ["darwin", "linux"] as const) {
  Deno.test(`sendTelemetryAtCommandEnd: on ${os} a command starts a sender and sends nothing itself (swamp-club#4457)`, async () => {
    await withSpooledContext(async (ctx) => {
      let started = 0;
      const sender = new CountingSender();
      await sendTelemetryAtCommandEnd(ctx, { succeeded: true }, {
        os,
        sender,
        startSender: () => {
          started++;
          return Promise.resolve(true);
        },
      });
      assertEquals(started, 1);
      assertEquals(sender.sent, 0);
    });
  });
}

Deno.test("sendTelemetryAtCommandEnd: a command with no distinct id starts no sender, which would exit at once and free the lock", async () => {
  await withSpooledContext(async (ctx) => {
    let started = 0;
    const sender = new CountingSender();
    await sendTelemetryAtCommandEnd(
      { ...ctx, userId: null, repoId: undefined },
      { succeeded: true },
      {
        os: "linux",
        sender,
        startSender: () => {
          started++;
          return Promise.resolve(true);
        },
      },
    );
    assertEquals(started, 0);
    assertEquals(sender.sent, 0);
  });
});
