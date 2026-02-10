import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderNoTelemetry,
  renderTelemetryStats,
  type TelemetryStatsData,
} from "./telemetry_stats_output.ts";

await initializeLogging({});

const testStats: TelemetryStatsData = {
  totalInvocations: 100,
  successCount: 85,
  errorCount: 10,
  userErrorCount: 5,
  successRate: 85.0,
  errorRate: 15.0,
  commandFrequency: {
    "model create": 40,
    "workflow run": 30,
    "model search": 20,
    "vault put": 10,
  },
  optionFrequency: {
    "--json": 50,
    "--verbose": 25,
    "--debug": 15,
  },
  averageDurationByCommand: {
    "model create": 150,
    "workflow run": 2500,
    "model search": 80,
    "vault put": 100,
  },
  platformDistribution: {
    linux: 60,
    darwin: 35,
    windows: 5,
  },
  daysAnalyzed: 7,
};

Deno.test("renderTelemetryStats with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTelemetryStats(testStats, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.totalInvocations, testStats.totalInvocations);
    assertEquals(parsed.successCount, testStats.successCount);
    assertEquals(parsed.errorCount, testStats.errorCount);
    assertEquals(parsed.commandFrequency["model create"], 40);
    assertEquals(parsed.platformDistribution.linux, 60);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderTelemetryStats with log mode outputs JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderTelemetryStats(testStats, "log");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.totalInvocations, testStats.totalInvocations);
    assertEquals(parsed.successCount, testStats.successCount);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderNoTelemetry with json mode outputs message JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderNoTelemetry("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.message, "No telemetry data found");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderNoTelemetry with log mode does not throw", () => {
  renderNoTelemetry("log");
});
