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
import type { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../src/domain/telemetry/telemetry_sender.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import {
  JsonTelemetryFlushRecordRepository,
  TELEMETRY_FLUSH_RECORD_FILE,
} from "../src/infrastructure/persistence/json_telemetry_flush_record_repository.ts";
import { JsonTelemetryRepository } from "../src/infrastructure/persistence/json_telemetry_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createTelemetryStatsDeps,
  telemetryStats,
  type TelemetryStatsEvent,
} from "../src/libswamp/telemetry/stats.ts";
import { collect } from "../src/libswamp/testing.ts";

class AcceptingSender implements TelemetrySender {
  result: TelemetryFlushResult = { ok: true };
  sendBatch(_entries: TelemetryEntry[]): Promise<TelemetryFlushResult> {
    return Promise.resolve(this.result);
  }
}

const INVOCATION = {
  command: "version",
  args: [],
  optionKeys: [],
  globalOptions: [],
};

async function withConfigDir(
  fn: (configDir: string, spoolDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-flush-record-it-" });
  try {
    await withMockedEnv(
      {
        SWAMP_CONFIG_DIR: dir,
        SWAMP_NO_TELEMETRY: undefined,
        DO_NOT_TRACK: undefined,
      },
      () => fn(dir, join(dir, "telemetry")),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function spoolService(spoolDir: string): TelemetryService {
  return new TelemetryService(
    new JsonTelemetryRepository("", spoolDir),
    "1.0.0",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new JsonTelemetryFlushRecordRepository(spoolDir),
  );
}

async function recordTwoAndFlush(
  spoolDir: string,
  keepFlushed: boolean,
): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await spoolService(spoolDir).recordSuccess(INVOCATION, new Date());
  }
  const outcome = await spoolService(spoolDir).flushTelemetry({
    sender: new AcceptingSender(),
    distinctId: "user",
    keepFlushed,
  });
  assertEquals(outcome.sentCount, 2);
}

async function statsCompleted(): Promise<
  Extract<TelemetryStatsEvent, { kind: "completed" }>
> {
  const events = await collect<TelemetryStatsEvent>(
    telemetryStats(
      createLibSwampContext(),
      createTelemetryStatsDeps("1.0.0"),
      { days: 2 },
    ),
  );
  const completed = events.find((e) => e.kind === "completed");
  assert(completed?.kind === "completed");
  return completed;
}

Deno.test("telemetry flush record: stats explains an emptied spool with the last flush", async () => {
  await withConfigDir(async (_configDir, spoolDir) => {
    await recordTwoAndFlush(spoolDir, false);

    const completed = await statsCompleted();

    assertEquals(completed.data, null);
    assertEquals(completed.emptyState?.telemetryEnabled, true);
    assertEquals(completed.emptyState?.lastFlush?.lastAttemptOk, true);
    assertEquals(completed.emptyState?.lastFlush?.lastSentCount, 2);
  });
});

Deno.test("telemetry flush record: with keepFlushed, stats counts the kept entries", async () => {
  await withConfigDir(async (_configDir, spoolDir) => {
    await recordTwoAndFlush(spoolDir, true);

    const completed = await statsCompleted();

    assertEquals(completed.data?.totalInvocations, 2);
    assertEquals(completed.emptyState, undefined);
  });
});

Deno.test("telemetry flush record: retention cleanup leaves the record in place", async () => {
  await withConfigDir(async (_configDir, spoolDir) => {
    await recordTwoAndFlush(spoolDir, true);
    const repository = new JsonTelemetryRepository("", spoolDir);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

    assertEquals(await repository.deleteAllOlderThan(future), 2);

    const stat = await Deno.stat(join(spoolDir, TELEMETRY_FLUSH_RECORD_FILE));
    assert(stat.isFile);
    assertEquals(await repository.findUnflushed(10), []);
  });
});
