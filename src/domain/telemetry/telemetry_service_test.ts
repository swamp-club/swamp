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

import { assertEquals } from "@std/assert";
import { TelemetryService } from "./telemetry_service.ts";
import type { TelemetryRepository } from "./repositories.ts";
import { TelemetryEntry, type TelemetryEntryData } from "./telemetry_entry.ts";

/** Mock repository for testing */
class MockTelemetryRepository implements TelemetryRepository {
  savedEntries: TelemetryEntry[] = [];
  mockEntries: TelemetryEntry[] = [];
  deletedBefore: Date | null = null;

  save(entry: TelemetryEntry): Promise<void> {
    this.savedEntries.push(entry);
    return Promise.resolve();
  }

  findByDate(_date: Date): Promise<TelemetryEntry[]> {
    return Promise.resolve(this.mockEntries);
  }

  findByDateRange(
    _startDate: Date,
    _endDate: Date,
  ): Promise<TelemetryEntry[]> {
    return Promise.resolve(this.mockEntries);
  }

  deleteOlderThan(date: Date): Promise<number> {
    this.deletedBefore = date;
    return Promise.resolve(5); // Mock deleted count
  }
}

Deno.test("TelemetryService.recordSuccess saves successful invocation", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  const startTime = new Date();
  await service.recordSuccess(
    {
      command: "model",
      subcommand: "create",
      args: ["<REDACTED>"],
      optionKeys: ["--repo-dir"],
      globalOptions: ["--json"],
    },
    startTime,
  );

  assertEquals(repo.savedEntries.length, 1);
  const saved = repo.savedEntries[0];
  assertEquals(saved.invocation.command, "model");
  assertEquals(saved.invocation.subcommand, "create");
  assertEquals(saved.result.status, "success");
  assertEquals(saved.result.exitCode, 0);
  assertEquals(saved.swampVersion, "1.0.0");
});

Deno.test("TelemetryService.recordError saves error invocation", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  const startTime = new Date();
  const error = new Error("Something went wrong");
  await service.recordError(
    {
      command: "workflow",
      subcommand: "run",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    startTime,
    error,
  );

  assertEquals(repo.savedEntries.length, 1);
  const saved = repo.savedEntries[0];
  assertEquals(saved.invocation.command, "workflow");
  assertEquals(saved.result.status, "error");
  assertEquals(saved.result.errorType, "Error");
  assertEquals(saved.result.errorMessage, "Something went wrong");
  assertEquals(saved.result.exitCode, 1);
});

Deno.test("TelemetryService.getStats calculates statistics correctly", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  // Set up mock entries
  const now = new Date();
  const entries: TelemetryEntryData[] = [
    {
      id: "1",
      invocation: {
        command: "model",
        subcommand: "create",
        args: [],
        optionKeys: ["--repo-dir"],
        globalOptions: ["--json"],
      },
      result: { status: "success", exitCode: 0 },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      durationMs: 100,
      swampVersion: "1.0.0",
      denoVersion: "2.1.0",
      platform: "linux",
    },
    {
      id: "2",
      invocation: {
        command: "model",
        subcommand: "create",
        args: [],
        optionKeys: [],
        globalOptions: [],
      },
      result: { status: "success", exitCode: 0 },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      durationMs: 200,
      swampVersion: "1.0.0",
      denoVersion: "2.1.0",
      platform: "linux",
    },
    {
      id: "3",
      invocation: {
        command: "workflow",
        subcommand: "run",
        args: [],
        optionKeys: [],
        globalOptions: [],
      },
      result: {
        status: "error",
        errorType: "Error",
        errorMessage: "Failed",
        exitCode: 1,
      },
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      durationMs: 50,
      swampVersion: "1.0.0",
      denoVersion: "2.1.0",
      platform: "darwin",
    },
  ];

  repo.mockEntries = entries.map((e) => TelemetryEntry.fromData(e));

  const stats = await service.getStats(2);

  assertEquals(stats.totalInvocations, 3);
  assertEquals(stats.successCount, 2);
  assertEquals(stats.errorCount, 1);
  assertEquals(stats.userErrorCount, 0);
  assertEquals(Math.round(stats.successRate), 67);
  assertEquals(Math.round(stats.errorRate), 33);
  assertEquals(stats.commandFrequency["model create"], 2);
  assertEquals(stats.commandFrequency["workflow run"], 1);
  assertEquals(stats.optionFrequency["--repo-dir"], 1);
  assertEquals(stats.optionFrequency["--json"], 1);
  assertEquals(stats.averageDurationByCommand["model create"], 150);
  assertEquals(stats.averageDurationByCommand["workflow run"], 50);
  assertEquals(stats.platformDistribution["linux"], 2);
  assertEquals(stats.platformDistribution["darwin"], 1);
  assertEquals(stats.daysAnalyzed, 2);
});

Deno.test("TelemetryService.getStats returns empty stats for no entries", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  repo.mockEntries = [];

  const stats = await service.getStats(2);

  assertEquals(stats.totalInvocations, 0);
  assertEquals(stats.successCount, 0);
  assertEquals(stats.errorCount, 0);
  assertEquals(stats.successRate, 0);
  assertEquals(stats.errorRate, 0);
  assertEquals(Object.keys(stats.commandFrequency).length, 0);
});
