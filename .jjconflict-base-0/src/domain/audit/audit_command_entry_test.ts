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
import {
  bashCommandEntryFromData,
  bashCommandEntryToData,
  createBashCommandEntry,
} from "./audit_command_entry.ts";

Deno.test("createBashCommandEntry creates entry with timestamp", () => {
  const entry = createBashCommandEntry("session-1", "aws s3 ls", "/repo");

  assertEquals(entry.sessionId, "session-1");
  assertEquals(entry.command, "aws s3 ls");
  assertEquals(entry.cwd, "/repo");
  // Timestamp should be a valid ISO string
  assertEquals(typeof entry.timestamp, "string");
  assertEquals(isNaN(new Date(entry.timestamp).getTime()), false);
});

Deno.test("bashCommandEntryToData converts to plain data object", () => {
  const entry = createBashCommandEntry("session-2", "terraform apply", "/home");
  const data = bashCommandEntryToData(entry);

  assertEquals(data.sessionId, "session-2");
  assertEquals(data.command, "terraform apply");
  assertEquals(data.cwd, "/home");
  assertEquals(data.timestamp, entry.timestamp);
});

Deno.test("bashCommandEntryFromData reconstructs from persisted data", () => {
  const data = {
    timestamp: "2025-01-15T10:30:00.000Z",
    sessionId: "session-3",
    command: "kubectl get pods",
    cwd: "/project",
  };

  const entry = bashCommandEntryFromData(data);

  assertEquals(entry.timestamp, "2025-01-15T10:30:00.000Z");
  assertEquals(entry.sessionId, "session-3");
  assertEquals(entry.command, "kubectl get pods");
  assertEquals(entry.cwd, "/project");
});

Deno.test("round-trip: create -> toData -> fromData preserves fields", () => {
  const original = createBashCommandEntry("s1", "docker ps", "/app");
  const data = bashCommandEntryToData(original);
  const restored = bashCommandEntryFromData(data);

  assertEquals(restored.sessionId, original.sessionId);
  assertEquals(restored.command, original.command);
  assertEquals(restored.cwd, original.cwd);
  assertEquals(restored.timestamp, original.timestamp);
});

Deno.test("createBashCommandEntry with failure includes exitCode and error", () => {
  const entry = createBashCommandEntry("s1", "aws s3 rm s3://bucket", "/repo", {
    exitCode: 1,
    error: "An error occurred (AccessDenied)",
  });

  assertEquals(entry.exitCode, 1);
  assertEquals(entry.error, "An error occurred (AccessDenied)");
});

Deno.test("createBashCommandEntry without failure omits exitCode and error", () => {
  const entry = createBashCommandEntry("s1", "aws s3 ls", "/repo");

  assertEquals(entry.exitCode, undefined);
  assertEquals(entry.error, undefined);
});

Deno.test("round-trip preserves failure fields", () => {
  const original = createBashCommandEntry("s1", "npm test", "/app", {
    exitCode: 255,
    error: "Command exited with non-zero status code 255",
  });
  const data = bashCommandEntryToData(original);
  const restored = bashCommandEntryFromData(data);

  assertEquals(restored.exitCode, 255);
  assertEquals(restored.error, "Command exited with non-zero status code 255");
});

Deno.test("bashCommandEntryToData omits failure fields when not present", () => {
  const entry = createBashCommandEntry("s1", "ls", "/app");
  const data = bashCommandEntryToData(entry);

  assertEquals("exitCode" in data, false);
  assertEquals("error" in data, false);
});

Deno.test("createBashCommandEntry with undefined sessionId omits sessionId", () => {
  const entry = createBashCommandEntry(undefined, "npm test", "/app");

  assertEquals(entry.sessionId, undefined);
  assertEquals("sessionId" in entry, false);
  assertEquals(entry.command, "npm test");
});

Deno.test("round-trip preserves missing sessionId", () => {
  const original = createBashCommandEntry(
    undefined,
    "cargo build",
    "/workspace",
  );
  const data = bashCommandEntryToData(original);
  const restored = bashCommandEntryFromData(data);

  assertEquals("sessionId" in data, false);
  assertEquals("sessionId" in restored, false);
  assertEquals(restored.command, "cargo build");
});

Deno.test("bashCommandEntryFromData handles missing sessionId in persisted data", () => {
  const data = {
    timestamp: "2025-01-15T10:30:00.000Z",
    command: "go test ./...",
    cwd: "/project",
  };

  const entry = bashCommandEntryFromData(data);

  assertEquals(entry.sessionId, undefined);
  assertEquals(entry.command, "go test ./...");
});
