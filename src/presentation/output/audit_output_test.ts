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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderAuditTimeline,
  renderAuditToolNotSupported,
  renderNoAuditData,
} from "./audit_output.ts";
import type { AuditTimeline } from "../../domain/audit/audit_service.ts";

await initializeLogging({});

const testTimeline: AuditTimeline = {
  entries: [
    {
      timestamp: "2025-01-15T10:00:00.000Z",
      source: "swamp",
      summary: "swamp model create",
      status: "success",
      durationMs: 150,
    },
    {
      timestamp: "2025-01-15T10:05:00.000Z",
      source: "direct",
      summary: "aws s3 ls",
      status: "success",
      sessionId: "session-1",
    },
  ],
  totalSwamp: 1,
  totalDirect: 1,
  hoursAnalyzed: 24,
};

Deno.test("renderAuditTimeline with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuditTimeline(testTimeline, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.totalSwamp, 1);
    assertEquals(parsed.totalDirect, 1);
    assertEquals(parsed.hoursAnalyzed, 24);
    assertEquals(parsed.entries.length, 2);
    assertEquals(parsed.entries[0].source, "swamp");
    assertEquals(parsed.entries[0].summary, "swamp model create");
    assertEquals(parsed.entries[1].source, "direct");
    assertEquals(parsed.entries[1].summary, "aws s3 ls");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditTimeline with log mode outputs formatted table", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderAuditTimeline(testTimeline, "log");
    // Should have header line, separator, and two entry lines
    // plus the summary from logger.info
    const allOutput = logs.join("\n");
    assertStringIncludes(allOutput, "Time");
    assertStringIncludes(allOutput, "Source");
    assertStringIncludes(allOutput, "Summary");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditTimeline with empty timeline shows no commands message", () => {
  const emptyTimeline: AuditTimeline = {
    entries: [],
    totalSwamp: 0,
    totalDirect: 0,
    hoursAnalyzed: 12,
  };

  // Should not throw
  renderAuditTimeline(emptyTimeline, "log");
});

Deno.test("renderNoAuditData with json mode outputs message", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderNoAuditData("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertStringIncludes(parsed.message, "No audit data found");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderNoAuditData with log mode does not throw", () => {
  renderNoAuditData("log");
});

Deno.test("renderAuditTimeline json mode includes sessionId when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuditTimeline(testTimeline, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.entries[1].sessionId, "session-1");
    assertEquals(parsed.entries[0].sessionId, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditTimeline json mode includes durationMs when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuditTimeline(testTimeline, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.entries[0].durationMs, 150);
    assertEquals(parsed.entries[1].durationMs, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditTimeline json mode includes error fields for failed commands", () => {
  const failureTimeline: AuditTimeline = {
    entries: [
      {
        timestamp: "2025-01-15T10:18:02.000Z",
        source: "direct",
        summary: "aws ec2 terminate-instances --instance-ids i-abc123",
        status: "error",
        sessionId: "session-1",
        exitCode: 255,
        error: "An error occurred (UnauthorizedOperation)",
      },
    ],
    totalSwamp: 0,
    totalDirect: 1,
    hoursAnalyzed: 24,
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuditTimeline(failureTimeline, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.entries[0].status, "error");
    assertEquals(parsed.entries[0].exitCode, 255);
    assertEquals(
      parsed.entries[0].error,
      "An error occurred (UnauthorizedOperation)",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditTimeline log mode shows error line for failed commands", () => {
  const failureTimeline: AuditTimeline = {
    entries: [
      {
        timestamp: "2025-01-15T10:18:02.000Z",
        source: "direct",
        summary: "aws ec2 terminate-instances",
        status: "error",
        sessionId: "session-1",
        exitCode: 1,
        error: "Access Denied",
      },
    ],
    totalSwamp: 0,
    totalDirect: 1,
    hoursAnalyzed: 24,
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));

  try {
    renderAuditTimeline(failureTimeline, "log");
    const allOutput = logs.join("\n");
    assertStringIncludes(allOutput, "ERROR");
    assertStringIncludes(allOutput, "exit 1");
    assertStringIncludes(allOutput, "Access Denied");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditToolNotSupported json mode outputs structured data", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuditToolNotSupported("codex", "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.supported, false);
    assertEquals(parsed.tool, "codex");
    assertStringIncludes(parsed.message, "Codex");
    assertStringIncludes(parsed.message, "per-command hooks");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuditToolNotSupported log mode does not throw", () => {
  renderAuditToolNotSupported("codex", "log");
});
