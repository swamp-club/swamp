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
  cleanErrorMessage,
  normalizeHookInput,
  parseExitCode,
} from "./hook_input.ts";

// ---- parseExitCode ----

Deno.test("parseExitCode extracts exit code from 'Exit code N' format", () => {
  assertEquals(parseExitCode("Exit code 254\n\nAn error occurred"), 254);
});

Deno.test("parseExitCode extracts exit code from 'status code N' format", () => {
  assertEquals(
    parseExitCode("Command exited with non-zero status code 1"),
    1,
  );
});

Deno.test("parseExitCode returns undefined for unrecognized format", () => {
  assertEquals(parseExitCode("Something went wrong"), undefined);
});

// ---- cleanErrorMessage ----

Deno.test("cleanErrorMessage strips Exit code prefix and collapses lines", () => {
  const result = cleanErrorMessage(
    "Exit code 1\n\nAn error occurred\nDetails here",
  );
  assertEquals(result, "An error occurred Details here");
});

Deno.test("cleanErrorMessage handles message without Exit code prefix", () => {
  const result = cleanErrorMessage("Some error message");
  assertEquals(result, "Some error message");
});

// ---- Claude normalization ----

Deno.test("normalizeHookInput claude: normalizes successful Bash tool", () => {
  const result = normalizeHookInput("claude", {
    session_id: "session-123",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "aws s3 ls" },
  });

  assertEquals(result, {
    command: "aws s3 ls",
    cwd: "/repo",
    sessionId: "session-123",
    isFailure: false,
  });
});

Deno.test("normalizeHookInput claude: normalizes failed Bash tool", () => {
  const result = normalizeHookInput("claude", {
    session_id: "session-123",
    cwd: "/repo",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "terraform apply" },
    error: "Exit code 1\n\nCommand failed",
  });

  assertEquals(result?.isFailure, true);
  assertEquals(result?.exitCode, 1);
  assertEquals(result?.errorMessage, "Command failed");
});

Deno.test("normalizeHookInput claude: skips non-Bash tools", () => {
  const result = normalizeHookInput("claude", {
    session_id: "session-123",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: "/etc/hosts" },
  });

  assertEquals(result, null);
});

Deno.test("normalizeHookInput claude: returns null for missing command", () => {
  const result = normalizeHookInput("claude", {
    session_id: "session-123",
    cwd: "/repo",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: {},
  });

  assertEquals(result, null);
});

// ---- Cursor normalization ----

Deno.test("normalizeHookInput cursor: normalizes successful Shell tool", () => {
  const result = normalizeHookInput("cursor", {
    cwd: "/project",
    tool_name: "Shell",
    tool_input: { command: "npm test" },
  });

  assertEquals(result, {
    command: "npm test",
    cwd: "/project",
    isFailure: false,
  });
});

Deno.test("normalizeHookInput cursor: normalizes failed Shell tool", () => {
  const result = normalizeHookInput("cursor", {
    cwd: "/project",
    tool_name: "Shell",
    tool_input: { command: "npm test" },
    error_message: "Tests failed",
  });

  assertEquals(result?.isFailure, true);
  assertEquals(result?.errorMessage, "Tests failed");
});

Deno.test("normalizeHookInput cursor: skips non-Shell tools", () => {
  const result = normalizeHookInput("cursor", {
    cwd: "/project",
    tool_name: "FileEdit",
    tool_input: { file: "foo.ts" },
  });

  assertEquals(result, null);
});

Deno.test("normalizeHookInput cursor: does not include sessionId", () => {
  const result = normalizeHookInput("cursor", {
    cwd: "/project",
    tool_name: "Shell",
    tool_input: { command: "ls" },
  });

  assertEquals(result?.sessionId, undefined);
});

// ---- Kiro normalization ----

Deno.test("normalizeHookInput kiro: normalizes successful execute_bash", () => {
  const result = normalizeHookInput("kiro", {
    cwd: "/workspace",
    tool_name: "execute_bash",
    tool_input: { command: "cargo build" },
    tool_response: { success: true },
  });

  assertEquals(result, {
    command: "cargo build",
    cwd: "/workspace",
    isFailure: false,
  });
});

Deno.test("normalizeHookInput kiro: normalizes failed execute_bash", () => {
  const result = normalizeHookInput("kiro", {
    cwd: "/workspace",
    tool_name: "execute_bash",
    tool_input: { command: "cargo test" },
    tool_response: { success: false, error: "compilation failed" },
  });

  assertEquals(result?.isFailure, true);
  assertEquals(result?.errorMessage, "compilation failed");
});

Deno.test("normalizeHookInput kiro: skips non-execute_bash tools", () => {
  const result = normalizeHookInput("kiro", {
    cwd: "/workspace",
    tool_name: "read_file",
    tool_input: { path: "/foo" },
  });

  assertEquals(result, null);
});

// ---- OpenCode normalization ----

Deno.test("normalizeHookInput opencode: normalizes successful bash", () => {
  const result = normalizeHookInput("opencode", {
    session_id: "oc-session-1",
    cwd: "/code",
    tool_name: "bash",
    tool_input: { command: "go test ./..." },
  });

  assertEquals(result, {
    command: "go test ./...",
    cwd: "/code",
    sessionId: "oc-session-1",
    isFailure: false,
  });
});

Deno.test("normalizeHookInput opencode: normalizes failed bash", () => {
  const result = normalizeHookInput("opencode", {
    session_id: "oc-session-1",
    cwd: "/code",
    tool_name: "bash",
    tool_input: { command: "go build" },
    error: "build failed",
  });

  assertEquals(result?.isFailure, true);
  assertEquals(result?.errorMessage, "build failed");
});

Deno.test("normalizeHookInput opencode: skips non-bash tools", () => {
  const result = normalizeHookInput("opencode", {
    session_id: "oc-session-1",
    cwd: "/code",
    tool_name: "file_write",
    tool_input: { path: "/foo" },
  });

  assertEquals(result, null);
});
