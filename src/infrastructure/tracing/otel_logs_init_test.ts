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

Deno.test("initLogs: disabled (undefined) when no endpoint and no console exporter", async () => {
  const provider = await initLogs({ exporterKind: "otlp" });
  assertEquals(provider, undefined);
  await shutdownLogs();
});

Deno.test("initLogs: disabled when OTEL_LOGS_EXPORTER=none even with an endpoint", async () => {
  const provider = await initLogs({
    endpoint: "http://localhost:4318",
    exporterKind: "none",
  });
  assertEquals(provider, undefined);
  await shutdownLogs();
});

Deno.test("initLogs: enabled (returns a provider) when an endpoint is set", async () => {
  const provider = await initLogs({
    endpoint: "http://localhost:4318",
  });
  assertExists(provider);
  assertEquals(typeof provider.getLogger, "function");
  await shutdownLogs();
});

Deno.test("initLogs: enabled in console mode without an endpoint", async () => {
  const provider = await initLogs({ exporterKind: "console" });
  assertExists(provider);
  await shutdownLogs();
});

Deno.test("initLogs: batch processor path initializes", async () => {
  const provider = await initLogs({
    endpoint: "http://localhost:4318",
    useBatch: true,
  });
  assertExists(provider);
  await shutdownLogs();
});

Deno.test("shutdownLogs: no-op and safe to call when logs were never initialized", async () => {
  await initLogs({ exporterKind: "otlp" }); // returns undefined
  await shutdownLogs();
  await shutdownLogs(); // double shutdown must not throw
});

Deno.test("initLogs: idempotent — a second call returns the same provider, not a new one", async () => {
  const first = await initLogs({
    endpoint: "http://localhost:4318",
  });
  const second = await initLogs({
    endpoint: "http://localhost:4318",
  });
  assertExists(first);
  assertStrictEquals(second, first);
  await shutdownLogs();
});
