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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { createReportGetRenderer } from "./report_get.ts";
import type { ReportGetEvent } from "../../libswamp/mod.ts";

Deno.test("report get log renderer - renders report content", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("log");
    const handlers = renderer.handlers();
    handlers.resolving({ kind: "resolving" });
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        markdown: "# Cost Report\nTotal: $42",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "cost-report");
    assertStringIncludes(combined, "my-ec2");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get json renderer - outputs JSON object", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("json");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        markdown: "# Cost Report",
        json: { total: 42 },
      },
    });

    const parsed = JSON.parse(output[0]);
    assertStringIncludes(parsed.reportName, "cost-report");
    assertStringIncludes(parsed.markdown, "# Cost Report");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get log renderer - includes Variant when varySuffix present", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("log");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        varySuffix: "10.0.0.1",
        markdown: "# Cost Report\nTotal: $42",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "Variant: 10.0.0.1");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get log renderer - omits Variant when varySuffix absent", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("log");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        markdown: "# Cost Report\nTotal: $42",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    assertEquals(combined.includes("Variant"), false);
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get markdown renderer - outputs raw markdown without ANSI escapes", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("markdown");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        markdown:
          "# Cost Report\n\n| Item | Cost |\n| --- | --- |\n| EC2 | $42 |",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    // deno-lint-ignore no-control-regex
    const ansiPattern = /\x1b\[/;
    assertEquals(ansiPattern.test(combined), false);
    assertStringIncludes(combined, "## cost-report");
    assertStringIncludes(combined, "Model: my-ec2 (aws/ec2)");
    assertStringIncludes(combined, "| Item | Cost |");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get markdown renderer - includes Variant when varySuffix present", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("markdown");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        varySuffix: "10.0.0.1",
        markdown: "# Cost Report\nTotal: $42",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "Variant: 10.0.0.1");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get markdown renderer - omits Variant when varySuffix absent", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("markdown");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "cost-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-cost",
        markdown: "# Cost Report\nTotal: $42",
        json: { total: 42 },
      },
    });

    const combined = output.join("\n");
    assertEquals(combined.includes("Variant"), false);
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get markdown renderer - shows workflow source", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("markdown");
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "audit-report",
        reportScope: "workflow",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 3,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-audit",
        workflowName: "deploy-pipeline",
        markdown: "# Audit\nAll good.",
        json: { status: "pass" },
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "Workflow: deploy-pipeline");
    assertEquals(combined.includes("Model:"), false);
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get log renderer - passes width options through", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("log", { maxColWidth: 10 });
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "test-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-test",
        markdown:
          "| Name | Value |\n| --- | --- |\n| ok | abcdefghijklmnopqrstuvwxyz |",
        json: {},
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "test-report");
    assertStringIncludes(combined, "ok");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get markdown renderer - applies maxColWidth to table cells", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("markdown", { maxColWidth: 10 });
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "test-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-test",
        markdown:
          "| Name | Value |\n| --- | --- |\n| ok | abcdefghijklmnopqrstuvwxyz |",
        json: {},
      },
    });

    const combined = output.join("\n");
    assertStringIncludes(combined, "…");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get json renderer - ignores width options", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);

  try {
    const renderer = createReportGetRenderer("json", { maxColWidth: 10 });
    const handlers = renderer.handlers();
    handlers.completed({
      kind: "completed",
      data: {
        reportName: "test-report",
        reportScope: "model",
        modelId: "test-id",
        modelName: "my-ec2",
        modelType: "aws/ec2",
        version: 1,
        createdAt: "2026-01-15T10:00:00.000Z",
        dataName: "report-test",
        markdown:
          "| Name | Value |\n| --- | --- |\n| ok | abcdefghijklmnopqrstuvwxyz |",
        json: {},
      },
    });

    const parsed = JSON.parse(output[0]);
    assertStringIncludes(parsed.markdown, "abcdefghijklmnopqrstuvwxyz");
  } finally {
    console.log = origLog;
  }
});

Deno.test("report get renderer - throws on error", () => {
  const renderer = createReportGetRenderer("log");
  const handlers = renderer.handlers();
  const errorEvent: ReportGetEvent = {
    kind: "error",
    error: { code: "not_found", message: "Report not found" },
  };
  assertThrows(
    () =>
      handlers.error(
        errorEvent as Extract<ReportGetEvent, { kind: "error" }>,
      ),
    Error,
    "Report not found",
  );
});
