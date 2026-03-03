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
import { AuditService, isNoiseCommand } from "./audit_service.ts";
import type { AuditRepository } from "./audit_repository.ts";
import type { BashCommandEntry } from "./audit_command_entry.ts";

/** Mock audit repository */
class MockAuditRepository implements AuditRepository {
  appendedEntries: BashCommandEntry[] = [];
  mockEntries: BashCommandEntry[] = [];
  deletedBefore: Date | null = null;

  append(entry: BashCommandEntry): Promise<void> {
    this.appendedEntries.push(entry);
    return Promise.resolve();
  }

  findByTimeRange(
    _startTime: Date,
    _endTime: Date,
  ): Promise<BashCommandEntry[]> {
    return Promise.resolve(this.mockEntries);
  }

  deleteOlderThan(date: Date): Promise<number> {
    this.deletedBefore = date;
    return Promise.resolve(1);
  }
}

function createTestBashEntry(
  command: string,
  sessionId: string = "session-1",
): BashCommandEntry {
  return {
    timestamp: "2025-01-15T10:05:00.000Z",
    sessionId,
    command,
    cwd: "/repo",
  };
}

Deno.test("AuditService.getTimeline categorizes swamp and direct commands", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("swamp model create my-vpc"),
    createTestBashEntry("aws s3 ls"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  assertEquals(timeline.totalSwamp, 1);
  assertEquals(timeline.totalDirect, 1);
  assertEquals(timeline.entries.length, 2);
  assertEquals(timeline.hoursAnalyzed, 24);

  const swampEntry = timeline.entries.find((e) => e.source === "swamp");
  assertEquals(swampEntry?.summary, "swamp model create my-vpc");

  const directEntry = timeline.entries.find((e) => e.source === "direct");
  assertEquals(directEntry?.summary, "aws s3 ls");
});

Deno.test("AuditService.getTimeline tags bare swamp command as swamp", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("swamp"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  assertEquals(timeline.totalSwamp, 1);
  assertEquals(timeline.entries[0].source, "swamp");
});

Deno.test("AuditService.getTimeline filters noise commands by default", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("ls -la"),
    createTestBashEntry("cat /etc/hosts"),
    createTestBashEntry("terraform plan"),
    createTestBashEntry("git status"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  // Only terraform plan should remain
  assertEquals(timeline.totalDirect, 1);
  assertEquals(timeline.entries[0].summary, "terraform plan");
});

Deno.test("AuditService.getTimeline shows all commands with showAll", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("ls -la"),
    createTestBashEntry("cat /etc/hosts"),
    createTestBashEntry("terraform plan"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: true,
  });

  assertEquals(timeline.totalDirect, 3);
});

Deno.test("AuditService.getTimeline filters by session ID", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("aws s3 ls", "session-A"),
    createTestBashEntry("terraform plan", "session-B"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
    sessionId: "session-A",
  });

  assertEquals(timeline.totalDirect, 1);
  assertEquals(timeline.entries[0].summary, "aws s3 ls");
});

Deno.test("AuditService.getTimeline session filter applies to swamp commands too", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("swamp model create vpc", "session-A"),
    createTestBashEntry("swamp model get vpc", "session-B"),
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
    sessionId: "session-A",
  });

  assertEquals(timeline.totalSwamp, 1);
  assertEquals(timeline.entries[0].summary, "swamp model create vpc");
});

Deno.test("AuditService.getTimeline sorts entries by timestamp", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    {
      timestamp: "2025-01-15T10:30:00.000Z",
      sessionId: "s1",
      command: "second-cmd",
      cwd: "/repo",
    },
    {
      timestamp: "2025-01-15T10:10:00.000Z",
      sessionId: "s1",
      command: "first-cmd",
      cwd: "/repo",
    },
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: true,
  });

  assertEquals(timeline.entries[0].summary, "first-cmd");
  assertEquals(timeline.entries[1].summary, "second-cmd");
});

Deno.test("AuditService.getTimeline returns empty for no data", async () => {
  const auditRepo = new MockAuditRepository();

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  assertEquals(timeline.entries.length, 0);
  assertEquals(timeline.totalSwamp, 0);
  assertEquals(timeline.totalDirect, 0);
});

Deno.test("AuditService.getTimeline marks failed direct commands as error", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    {
      timestamp: "2025-01-15T10:05:00.000Z",
      sessionId: "s1",
      command: "aws ec2 terminate-instances --instance-ids i-abc123",
      cwd: "/repo",
      exitCode: 255,
      error: "An error occurred (UnauthorizedOperation)",
    },
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  assertEquals(timeline.entries.length, 1);
  assertEquals(timeline.entries[0].status, "error");
  assertEquals(timeline.entries[0].exitCode, 255);
  assertEquals(
    timeline.entries[0].error,
    "An error occurred (UnauthorizedOperation)",
  );
});

Deno.test("AuditService.getTimeline marks failed swamp commands as error", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    {
      timestamp: "2025-01-15T10:05:00.000Z",
      sessionId: "s1",
      command: "swamp model method run my-vpc sync",
      cwd: "/repo",
      exitCode: 1,
      error: "Command exited with non-zero status code 1",
    },
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
  });

  assertEquals(timeline.entries.length, 1);
  assertEquals(timeline.entries[0].source, "swamp");
  assertEquals(timeline.entries[0].status, "error");
});

Deno.test("isNoiseCommand correctly identifies noise commands", () => {
  assertEquals(isNoiseCommand("ls"), true);
  assertEquals(isNoiseCommand("ls -la"), true);
  assertEquals(isNoiseCommand("cat foo.txt"), true);
  assertEquals(isNoiseCommand("echo hello"), true);
  assertEquals(isNoiseCommand("grep pattern"), true);
  assertEquals(isNoiseCommand("git status"), true);
  assertEquals(isNoiseCommand("git log --oneline"), true);
  assertEquals(isNoiseCommand("pwd"), true);
  assertEquals(isNoiseCommand("cd /tmp"), true);
});

Deno.test("isNoiseCommand correctly identifies non-noise commands", () => {
  assertEquals(isNoiseCommand("aws s3 ls"), false);
  assertEquals(isNoiseCommand("terraform plan"), false);
  assertEquals(isNoiseCommand("kubectl apply -f"), false);
  assertEquals(isNoiseCommand("docker run nginx"), false);
  assertEquals(isNoiseCommand("git push"), false);
  assertEquals(isNoiseCommand("git commit -m 'test'"), false);
});

Deno.test("isNoiseCommand handles pipe-separated noise", () => {
  assertEquals(isNoiseCommand("ls|grep foo"), true);
  assertEquals(isNoiseCommand("cat foo|wc -l"), true);
});

Deno.test("isNoiseCommand handles semicolon-separated noise", () => {
  assertEquals(isNoiseCommand("ls;echo done"), true);
});

Deno.test("AuditService.getTimeline excludes entries without sessionId when filtering by session", async () => {
  const auditRepo = new MockAuditRepository();

  auditRepo.mockEntries = [
    createTestBashEntry("aws s3 ls", "session-A"),
    {
      timestamp: "2025-01-15T10:05:00.000Z",
      command: "cargo build",
      cwd: "/repo",
      // no sessionId — should be excluded when filtering by session
    },
  ];

  const service = new AuditService(auditRepo);
  const timeline = await service.getTimeline({
    hours: 24,
    showAll: false,
    sessionId: "session-A",
  });

  assertEquals(timeline.totalDirect, 1);
  assertEquals(timeline.entries[0].summary, "aws s3 ls");
});
