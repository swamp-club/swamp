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
import { join } from "@std/path";
import { JsonlAuditRepository } from "./jsonl_audit_repository.ts";
import { createBashCommandEntry } from "../../domain/audit/audit_command_entry.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("JsonlAuditRepository.append creates directory and file", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);
    const entry = createBashCommandEntry("session-1", "aws s3 ls", "/repo");

    await repo.append(entry);

    const auditDir = join(dir, ".swamp", "audit");
    const dirInfo = await Deno.stat(auditDir);
    assertEquals(dirInfo.isDirectory, true);

    // Check that a JSONL file was created
    const files: string[] = [];
    for await (const f of Deno.readDir(auditDir)) {
      files.push(f.name);
    }
    assertEquals(files.length, 1);
    assertEquals(files[0].startsWith("commands-"), true);
    assertEquals(files[0].endsWith(".jsonl"), true);
  });
});

Deno.test("JsonlAuditRepository.append writes valid JSONL lines", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);

    const entry1 = createBashCommandEntry("s1", "aws s3 ls", "/repo");
    const entry2 = createBashCommandEntry("s1", "terraform plan", "/repo");

    await repo.append(entry1);
    await repo.append(entry2);

    // Read the file and verify two JSONL lines
    const auditDir = join(dir, ".swamp", "audit");
    let filename = "";
    for await (const f of Deno.readDir(auditDir)) {
      filename = f.name;
    }
    const content = await Deno.readTextFile(join(auditDir, filename));
    const lines = content.split("\n").filter((l) => l.trim());
    assertEquals(lines.length, 2);

    const parsed1 = JSON.parse(lines[0]);
    assertEquals(parsed1.command, "aws s3 ls");

    const parsed2 = JSON.parse(lines[1]);
    assertEquals(parsed2.command, "terraform plan");
  });
});

Deno.test("JsonlAuditRepository.findByTimeRange returns entries in range", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);

    // Manually write a JSONL file for a known date
    const auditDir = join(dir, ".swamp", "audit");
    await Deno.mkdir(auditDir, { recursive: true });

    const entries = [
      {
        timestamp: "2025-01-15T10:00:00.000Z",
        sessionId: "s1",
        command: "aws s3 ls",
        cwd: "/repo",
      },
      {
        timestamp: "2025-01-15T12:00:00.000Z",
        sessionId: "s1",
        command: "terraform apply",
        cwd: "/repo",
      },
    ];

    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await Deno.writeTextFile(
      join(auditDir, "commands-2025-01-15.jsonl"),
      content,
    );

    const startTime = new Date("2025-01-15T09:00:00.000Z");
    const endTime = new Date("2025-01-15T11:00:00.000Z");

    const result = await repo.findByTimeRange(startTime, endTime);

    // Only the first entry should be in range
    assertEquals(result.length, 1);
    assertEquals(result[0].command, "aws s3 ls");
  });
});

Deno.test("JsonlAuditRepository.findByTimeRange returns empty for missing directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);

    const result = await repo.findByTimeRange(
      new Date("2025-01-15T00:00:00Z"),
      new Date("2025-01-15T23:59:59Z"),
    );

    assertEquals(result.length, 0);
  });
});

Deno.test("JsonlAuditRepository.deleteOlderThan removes old files", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);

    const auditDir = join(dir, ".swamp", "audit");
    await Deno.mkdir(auditDir, { recursive: true });

    // Create files for different dates
    await Deno.writeTextFile(
      join(auditDir, "commands-2025-01-10.jsonl"),
      '{"timestamp":"2025-01-10T10:00:00.000Z","sessionId":"s1","command":"old","cwd":"."}\n',
    );
    await Deno.writeTextFile(
      join(auditDir, "commands-2025-01-20.jsonl"),
      '{"timestamp":"2025-01-20T10:00:00.000Z","sessionId":"s1","command":"new","cwd":"."}\n',
    );

    const cutoff = new Date("2025-01-15T00:00:00Z");
    const deleted = await repo.deleteOlderThan(cutoff);

    assertEquals(deleted, 1);

    // Verify only the newer file remains
    const files: string[] = [];
    for await (const f of Deno.readDir(auditDir)) {
      files.push(f.name);
    }
    assertEquals(files.length, 1);
    assertEquals(files[0], "commands-2025-01-20.jsonl");
  });
});

Deno.test("JsonlAuditRepository.deleteOlderThan returns 0 for missing directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new JsonlAuditRepository(dir);
    const deleted = await repo.deleteOlderThan(new Date());
    assertEquals(deleted, 0);
  });
});

Deno.test("JsonlAuditRepository.append silently handles non-existent repo dir", async () => {
  const repo = new JsonlAuditRepository(
    "/nonexistent/path/that/does/not/exist",
  );
  const entry = createBashCommandEntry("s1", "test", ".");

  // Should not throw
  await repo.append(entry);
});
