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
import type { TelemetrySender } from "./telemetry_sender.ts";
import { TelemetryEntry, type TelemetryEntryData } from "./telemetry_entry.ts";

/** Mock repository for testing */
class MockTelemetryRepository implements TelemetryRepository {
  savedEntries: TelemetryEntry[] = [];
  mockEntries: TelemetryEntry[] = [];
  mockUnflushedEntries: TelemetryEntry[] = [];
  flushedEntries: TelemetryEntry[] = [];
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

  findUnflushed(_limit: number): Promise<TelemetryEntry[]> {
    return Promise.resolve(this.mockUnflushedEntries);
  }

  markFlushed(entry: TelemetryEntry, _keepFlushed?: boolean): Promise<void> {
    this.flushedEntries.push(entry);
    return Promise.resolve();
  }
}

/** Mock sender for testing */
class MockTelemetrySender implements TelemetrySender {
  sentBatches: Array<{
    entries: TelemetryEntry[];
    distinctId: string;
    repoId?: string;
    authToken?: string;
  }> = [];
  shouldSucceed = true;

  sendBatch(
    entries: TelemetryEntry[],
    distinctId: string,
    repoId?: string,
    authToken?: string,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    this.sentBatches.push({ entries, distinctId, repoId, authToken });
    return Promise.resolve(this.shouldSucceed);
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

function createFlushTestEntry(id: string, date: Date): TelemetryEntry {
  return TelemetryEntry.create({
    id,
    invocation: {
      command: "model",
      subcommand: "create",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt: date,
    completedAt: new Date(date.getTime() + 100),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  });
}

Deno.test("TelemetryService.flushTelemetry sends unflushed entries and marks them flushed", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  const service = new TelemetryService(repo, "1.0.0");

  const entry1 = createFlushTestEntry(
    "uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );
  const entry2 = createFlushTestEntry(
    "uuid-2",
    new Date("2024-03-10T11:00:00Z"),
  );
  repo.mockUnflushedEntries = [entry1, entry2];

  await service.flushTelemetry({ sender, distinctId: "repo-uuid" });

  assertEquals(sender.sentBatches.length, 1);
  assertEquals(sender.sentBatches[0].entries.length, 2);
  assertEquals(sender.sentBatches[0].distinctId, "repo-uuid");
  assertEquals(repo.flushedEntries.length, 2);
});

Deno.test("TelemetryService.flushTelemetry does not mark flushed on send failure", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  sender.shouldSucceed = false;
  const service = new TelemetryService(repo, "1.0.0");

  const entry = createFlushTestEntry(
    "uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );
  repo.mockUnflushedEntries = [entry];

  await service.flushTelemetry({ sender, distinctId: "repo-uuid" });

  assertEquals(sender.sentBatches.length, 1);
  assertEquals(repo.flushedEntries.length, 0);
});

Deno.test("TelemetryService.flushTelemetry is a no-op when no unflushed entries", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  const service = new TelemetryService(repo, "1.0.0");

  repo.mockUnflushedEntries = [];

  await service.flushTelemetry({ sender, distinctId: "repo-uuid" });

  assertEquals(sender.sentBatches.length, 0);
  assertEquals(repo.flushedEntries.length, 0);
});

Deno.test("TelemetryService.flushTelemetry passes repoId to sender", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  const service = new TelemetryService(repo, "1.0.0");

  const entry = createFlushTestEntry(
    "uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );
  repo.mockUnflushedEntries = [entry];

  await service.flushTelemetry({
    sender,
    distinctId: "user-uuid",
    repoId: "repo-uuid-456",
  });

  assertEquals(sender.sentBatches.length, 1);
  assertEquals(sender.sentBatches[0].distinctId, "user-uuid");
  assertEquals(sender.sentBatches[0].repoId, "repo-uuid-456");
});

Deno.test("TelemetryService.flushTelemetry passes authToken to sender", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  const service = new TelemetryService(repo, "1.0.0");

  const entry = createFlushTestEntry(
    "uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );
  repo.mockUnflushedEntries = [entry];

  await service.flushTelemetry({
    sender,
    distinctId: "user-uuid",
    repoId: "repo-uuid-456",
    authToken: "test-api-key-123",
  });

  assertEquals(sender.sentBatches.length, 1);
  assertEquals(sender.sentBatches[0].authToken, "test-api-key-123");
});

Deno.test("TelemetryService.flushTelemetry passes undefined authToken when not provided", async () => {
  const repo = new MockTelemetryRepository();
  const sender = new MockTelemetrySender();
  const service = new TelemetryService(repo, "1.0.0");

  const entry = createFlushTestEntry(
    "uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );
  repo.mockUnflushedEntries = [entry];

  await service.flushTelemetry({
    sender,
    distinctId: "user-uuid",
  });

  assertEquals(sender.sentBatches.length, 1);
  assertEquals(sender.sentBatches[0].authToken, undefined);
});

Deno.test("TelemetryService.recordSuccess stamps invocationContext on entries", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0", {
    configuredAiTools: ["claude", "cursor"],
    detectedAiTool: "claude",
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });

  await service.recordSuccess(
    {
      command: "model",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    new Date(),
  );

  const ctx = repo.savedEntries[0].invocationContext;
  assertEquals(ctx?.configuredAiTools, ["claude", "cursor"]);
  assertEquals(ctx?.detectedAiTool, "claude");
  assertEquals(ctx?.agentSessionDetected, true);
  assertEquals(ctx?.isInteractive, false);
});

Deno.test("TelemetryService.recordError stamps invocationContext on entries", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0", {
    configuredAiTools: [],
    agentSessionDetected: true,
    isInteractive: false,
    externalDatastoreConfigured: false,
  });

  await service.recordError(
    {
      command: "workflow",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    new Date(),
    new Error("boom"),
  );

  const ctx = repo.savedEntries[0].invocationContext;
  assertEquals(ctx?.configuredAiTools, []);
  assertEquals(ctx?.detectedAiTool, undefined);
  assertEquals(ctx?.agentSessionDetected, true);
  assertEquals(ctx?.isInteractive, false);
});

Deno.test("TelemetryService without invocationContext writes entries without the field", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  await service.recordSuccess(
    {
      command: "model",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    new Date(),
  );

  assertEquals(repo.savedEntries[0].invocationContext, undefined);
});

Deno.test("TelemetryService.recordChildInvocation writes a success child entry", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  const startedAt = new Date("2026-02-05T10:00:00Z");
  const completedAt = new Date("2026-02-05T10:00:00.500Z");

  await service.recordChildInvocation(
    {
      command: "model",
      subcommand: "method",
      args: ["run", "<REDACTED>", "validate"],
      optionKeys: [],
      globalOptions: [],
    },
    startedAt,
    completedAt,
    null,
    "parent-id-1",
    {
      workflowName: "deploy",
      runId: "run-1",
      jobName: "build",
      stepName: "step-a",
      modelType: "@swamp/shell",
      driver: "local",
    },
  );

  assertEquals(repo.savedEntries.length, 1);
  const saved = repo.savedEntries[0];
  assertEquals(saved.result.status, "success");
  assertEquals(saved.parentInvocationId, "parent-id-1");
  assertEquals(saved.workflowContext?.workflowName, "deploy");
  assertEquals(saved.workflowContext?.driver, "local");
  assertEquals(saved.durationMs, 500);
});

Deno.test("TelemetryService.recordChildInvocation classifies UserError as user_error", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  // Reuse the runtime's UserError surface — the service imports it from
  // ../errors.ts at the top of the file. We construct a UserError-shaped
  // instance via dynamic import to avoid coupling this test file to the
  // domain errors module path.
  const { UserError } = await import("../errors.ts");

  await service.recordChildInvocation(
    {
      command: "model",
      subcommand: "method",
      args: ["run", "<REDACTED>", "transform"],
      optionKeys: [],
      globalOptions: [],
    },
    new Date(),
    new Date(),
    new UserError("vary key missing"),
    "parent-id-2",
    {
      workflowName: "etl",
      runId: "run-2",
      jobName: "extract",
      stepName: "pull",
    },
  );

  assertEquals(repo.savedEntries[0].result.status, "user_error");
  assertEquals(repo.savedEntries[0].result.errorType, "UserError");
  assertEquals(repo.savedEntries[0].result.errorMessage, "vary key missing");
});

Deno.test("TelemetryService.recordChildInvocation supports zero-duration entries (pre-method-executing failure)", async () => {
  const repo = new MockTelemetryRepository();
  const service = new TelemetryService(repo, "1.0.0");

  const sameInstant = new Date("2026-02-05T10:00:00Z");

  await service.recordChildInvocation(
    {
      command: "model",
      subcommand: "method",
      args: ["run", "<REDACTED>", "enrich"],
      optionKeys: [],
      globalOptions: [],
    },
    sameInstant,
    sameInstant,
    new Error("model 'missing' not found"),
    "parent-id-3",
    {
      workflowName: "etl",
      runId: "run-3",
      jobName: "lookup",
      stepName: "fetch",
    },
  );

  assertEquals(repo.savedEntries[0].durationMs, 0);
  assertEquals(repo.savedEntries[0].result.status, "error");
  assertEquals(repo.savedEntries[0].workflowContext?.modelType, undefined);
  assertEquals(repo.savedEntries[0].workflowContext?.driver, undefined);
});
