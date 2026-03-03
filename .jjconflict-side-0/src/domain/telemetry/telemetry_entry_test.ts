// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertExists } from "@std/assert";
import { TelemetryEntry, type TelemetryEntryData } from "./telemetry_entry.ts";

Deno.test("TelemetryEntry.create creates entry with generated ID", () => {
  const entry = TelemetryEntry.create({
    invocation: {
      command: "model",
      subcommand: "create",
      args: ["<REDACTED>"],
      optionKeys: ["--repo-dir"],
      globalOptions: ["--json"],
    },
    result: {
      status: "success",
      exitCode: 0,
    },
    startedAt: new Date("2026-02-05T10:00:00Z"),
    completedAt: new Date("2026-02-05T10:00:01Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  });

  assertExists(entry.id);
  assertEquals(entry.invocation.command, "model");
  assertEquals(entry.invocation.subcommand, "create");
  assertEquals(entry.invocation.args, ["<REDACTED>"]);
  assertEquals(entry.invocation.optionKeys, ["--repo-dir"]);
  assertEquals(entry.invocation.globalOptions, ["--json"]);
  assertEquals(entry.result.status, "success");
  assertEquals(entry.result.exitCode, 0);
  assertEquals(entry.durationMs, 1000);
  assertEquals(entry.swampVersion, "1.0.0");
  assertEquals(entry.denoVersion, "2.1.0");
  assertEquals(entry.platform, "linux");
});

Deno.test("TelemetryEntry.create with explicit ID uses provided ID", () => {
  const entry = TelemetryEntry.create({
    id: "test-id-123",
    invocation: {
      command: "workflow",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    result: {
      status: "error",
      errorType: "Error",
      errorMessage: "Something went wrong",
      exitCode: 1,
    },
    startedAt: new Date("2026-02-05T10:00:00Z"),
    completedAt: new Date("2026-02-05T10:00:00.500Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "darwin",
  });

  assertEquals(entry.id, "test-id-123");
  assertEquals(entry.result.status, "error");
  assertEquals(entry.result.errorType, "Error");
  assertEquals(entry.result.errorMessage, "Something went wrong");
  assertEquals(entry.durationMs, 500);
});

Deno.test("TelemetryEntry.toData serializes to data object", () => {
  const entry = TelemetryEntry.create({
    id: "test-id-456",
    invocation: {
      command: "model",
      subcommand: "run",
      args: ["<REDACTED>", "<REDACTED>"],
      optionKeys: ["--verbose"],
      globalOptions: ["--verbose"],
    },
    result: {
      status: "user_error",
      errorType: "UserError",
      errorMessage: "Invalid input",
      exitCode: 1,
    },
    startedAt: new Date("2026-02-05T10:00:00Z"),
    completedAt: new Date("2026-02-05T10:00:02Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  });

  const data = entry.toData();

  assertEquals(data.id, "test-id-456");
  assertEquals(data.invocation.command, "model");
  assertEquals(data.invocation.subcommand, "run");
  assertEquals(data.invocation.args, ["<REDACTED>", "<REDACTED>"]);
  assertEquals(data.result.status, "user_error");
  assertEquals(data.result.errorType, "UserError");
  assertEquals(data.durationMs, 2000);
  assertEquals(data.startedAt, "2026-02-05T10:00:00.000Z");
  assertEquals(data.completedAt, "2026-02-05T10:00:02.000Z");
});

Deno.test("TelemetryEntry.fromData reconstructs entry from data", () => {
  const data: TelemetryEntryData = {
    id: "test-id-789",
    invocation: {
      command: "data",
      subcommand: "gc",
      args: [],
      optionKeys: ["--dry-run"],
      globalOptions: [],
    },
    result: {
      status: "success",
      exitCode: 0,
    },
    startedAt: "2026-02-05T12:00:00.000Z",
    completedAt: "2026-02-05T12:00:01.500Z",
    durationMs: 1500,
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  };

  const entry = TelemetryEntry.fromData(data);

  assertEquals(entry.id, "test-id-789");
  assertEquals(entry.invocation.command, "data");
  assertEquals(entry.invocation.subcommand, "gc");
  assertEquals(entry.result.status, "success");
  assertEquals(entry.durationMs, 1500);
  assertEquals(entry.startedAt.toISOString(), "2026-02-05T12:00:00.000Z");
  assertEquals(entry.completedAt.toISOString(), "2026-02-05T12:00:01.500Z");
});
