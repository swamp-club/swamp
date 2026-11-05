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
import { join } from "@std/path";
import {
  JsonTelemetryFlushRecordRepository,
  TELEMETRY_FLUSH_RECORD_FILE,
} from "./json_telemetry_flush_record_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-flush-record-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const RECORD = {
  lastAttemptAt: "2026-11-05T10:00:00.000Z",
  lastAttemptOk: false,
  lastFailureReason: "timeout",
  lastSuccessAt: "2026-11-05T09:00:00.000Z",
  lastSentCount: 4,
};

Deno.test("JsonTelemetryFlushRecordRepository: round-trips a record", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryFlushRecordRepository(join(dir, "telemetry"));
    await repo.write(RECORD);
    assertEquals(await repo.read(), RECORD);
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: a missing file reads as null", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await new JsonTelemetryFlushRecordRepository(dir).read(),
      null,
    );
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: malformed JSON reads as null", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, TELEMETRY_FLUSH_RECORD_FILE), "{not");
    assertEquals(
      await new JsonTelemetryFlushRecordRepository(dir).read(),
      null,
    );
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: wrong field types read as null", async () => {
  const invalid = [
    { ...RECORD, lastSentCount: "4" },
    { ...RECORD, lastSentCount: -1 },
    { ...RECORD, lastSentCount: 1.5 },
    { ...RECORD, lastAttemptAt: "yesterday" },
    { ...RECORD, lastSuccessAt: 12 },
    { ...RECORD, lastAttemptOk: "true" },
    { ...RECORD, lastFailureReason: "x".repeat(201) },
    { lastAttemptOk: true },
    { lastAttemptAt: RECORD.lastAttemptAt, lastAttemptOk: true },
    {
      lastAttemptAt: RECORD.lastAttemptAt,
      lastAttemptOk: true,
      lastSuccessAt: RECORD.lastSuccessAt,
    },
    { ...RECORD, lastSentCount: undefined },
    {
      lastAttemptAt: RECORD.lastAttemptAt,
      lastAttemptOk: false,
      lastSentCount: 2,
    },
    [],
    null,
  ];
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryFlushRecordRepository(dir);
    for (const value of invalid) {
      await Deno.writeTextFile(
        join(dir, TELEMETRY_FLUSH_RECORD_FILE),
        JSON.stringify(value),
      );
      assertEquals(await repo.read(), null, JSON.stringify(value));
    }
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: write truncates a long reason so it reads back", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryFlushRecordRepository(dir);
    await repo.write({ ...RECORD, lastFailureReason: "y".repeat(500) });
    assertEquals((await repo.read())?.lastFailureReason, "y".repeat(200));
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: write never throws when the directory cannot be made", async () => {
  await withTempDir(async (dir) => {
    const blocker = join(dir, "blocker");
    await Deno.writeTextFile(blocker, "");
    const repo = new JsonTelemetryFlushRecordRepository(
      join(blocker, "telemetry"),
    );
    await repo.write(RECORD);
    assertEquals(await repo.read(), null);
  });
});

Deno.test("JsonTelemetryFlushRecordRepository: a first failure with no success fields reads back", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonTelemetryFlushRecordRepository(dir);
    const record = {
      lastAttemptAt: RECORD.lastAttemptAt,
      lastAttemptOk: false,
      lastFailureReason: "timeout",
    };
    await repo.write(record);
    assertEquals(await repo.read(), record);
  });
});
