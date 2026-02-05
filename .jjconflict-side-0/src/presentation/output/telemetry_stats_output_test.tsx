import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderNoTelemetry,
  renderTelemetryStats,
  type TelemetryStatsData,
} from "./telemetry_stats_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

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

Deno.test({
  name: "renderTelemetryStats with interactive mode outputs to console",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      assertEquals(logs.length, 1);
      // Interactive mode should output rendered component, not JSON
      assertStringIncludes(logs[0], "Telemetry Statistics");
    } finally {
      console.log = originalLog;
    }
  },
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

Deno.test({
  name: "renderNoTelemetry with interactive mode shows warning",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderNoTelemetry("interactive");
      assertEquals(logs.length, 1);
      assertStringIncludes(logs[0], "No telemetry data found");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay renders overview section with stats",
  ...inkTestOptions,
  fn: () => {
    // We need to test the component indirectly through renderTelemetryStats
    // since TelemetryStatsDisplay is not exported
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "Overview");
      assertStringIncludes(output, "Total invocations: 100");
      assertStringIncludes(output, "Success: 85");
      assertStringIncludes(output, "85.0%");
      assertStringIncludes(output, "Errors: 15");
      assertStringIncludes(output, "15.0%");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay renders top commands sorted by frequency",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "Top Commands");
      assertStringIncludes(output, "model create: 40");
      assertStringIncludes(output, "workflow run: 30");
      assertStringIncludes(output, "model search: 20");

      // Verify commands are sorted (model create:40 should appear before workflow run:30)
      const modelCreateIndex = output.indexOf("model create");
      const workflowRunIndex = output.indexOf("workflow run");
      assertEquals(modelCreateIndex < workflowRunIndex, true);
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay renders top options sorted by frequency",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "Top Options");
      assertStringIncludes(output, "--json: 50");
      assertStringIncludes(output, "--verbose: 25");

      // Verify options are sorted (--json:50 should appear before --verbose:25)
      const jsonIndex = output.indexOf("--json");
      const verboseIndex = output.indexOf("--verbose");
      assertEquals(jsonIndex < verboseIndex, true);
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay renders platform distribution",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "Platforms");
      assertStringIncludes(output, "linux: 60");
      assertStringIncludes(output, "darwin: 35");
      assertStringIncludes(output, "windows: 5");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay handles empty stats gracefully",
  ...inkTestOptions,
  fn: () => {
    const emptyStats: TelemetryStatsData = {
      totalInvocations: 0,
      successCount: 0,
      errorCount: 0,
      userErrorCount: 0,
      successRate: 0,
      errorRate: 0,
      commandFrequency: {},
      optionFrequency: {},
      averageDurationByCommand: {},
      platformDistribution: {},
      daysAnalyzed: 7,
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(emptyStats, "interactive");
      const output = logs[0];

      // Should still render the header and overview
      assertStringIncludes(output, "Telemetry Statistics");
      assertStringIncludes(output, "Total invocations: 0");

      // Should NOT render sections that have no data
      assertEquals(output.includes("Top Commands"), false);
      assertEquals(output.includes("Top Options"), false);
      assertEquals(output.includes("Platforms"), false);
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay shows user errors when present",
  ...inkTestOptions,
  fn: () => {
    const statsWithUserErrors: TelemetryStatsData = {
      ...testStats,
      userErrorCount: 5,
    };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(statsWithUserErrors, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "User errors: 5");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "TelemetryStatsDisplay shows average duration for commands",
  ...inkTestOptions,
  fn: () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      renderTelemetryStats(testStats, "interactive");
      const output = logs[0];

      assertStringIncludes(output, "avg: 150ms");
      assertStringIncludes(output, "avg: 2500ms");
    } finally {
      console.log = originalLog;
    }
  },
});
