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

import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import { initLogs, shutdownLogs } from "./otel_logs_init.ts";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_LOGS_EXPORTER",
  "OTEL_BLRP_USE",
  "OTEL_EXPORTER_OTLP_HEADERS",
];

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = Deno.env.get(key);
  try {
    for (const key of ENV_KEYS) Deno.env.delete(key);
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) Deno.env.set(key, value);
    }
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("initLogs: disabled (undefined) when no endpoint and no console exporter", async () => {
  await withEnv({}, async () => {
    const provider = await initLogs();
    assertEquals(provider, undefined);
    await shutdownLogs();
  });
});

Deno.test("initLogs: disabled when OTEL_LOGS_EXPORTER=none even with an endpoint", async () => {
  await withEnv(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_LOGS_EXPORTER: "none",
    },
    async () => {
      const provider = await initLogs();
      assertEquals(provider, undefined);
      await shutdownLogs();
    },
  );
});

Deno.test("initLogs: enabled (returns a provider) when an endpoint is set", async () => {
  await withEnv(
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
    async () => {
      const provider = await initLogs();
      assertExists(provider);
      assertEquals(typeof provider.getLogger, "function");
      await shutdownLogs();
    },
  );
});

Deno.test("initLogs: enabled in console mode without an endpoint", async () => {
  await withEnv({ OTEL_LOGS_EXPORTER: "console" }, async () => {
    const provider = await initLogs();
    assertExists(provider);
    await shutdownLogs();
  });
});

Deno.test("initLogs: batch processor path (OTEL_BLRP_USE=1) initializes", async () => {
  await withEnv(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      OTEL_BLRP_USE: "1",
    },
    async () => {
      const provider = await initLogs();
      assertExists(provider);
      await shutdownLogs();
    },
  );
});

Deno.test("shutdownLogs: no-op and safe to call when logs were never initialized", async () => {
  await withEnv({}, async () => {
    await initLogs(); // returns undefined
    await shutdownLogs();
    await shutdownLogs(); // double shutdown must not throw
  });
});

Deno.test("initLogs: idempotent — a second call returns the same provider, not a new one", async () => {
  await withEnv(
    { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" },
    async () => {
      const first = await initLogs();
      const second = await initLogs();
      assertExists(first);
      // Same instance — no second provider was built (and leaked).
      assertStrictEquals(second, first);
      await shutdownLogs();
    },
  );
});
