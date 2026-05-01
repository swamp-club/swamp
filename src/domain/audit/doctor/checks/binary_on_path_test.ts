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
import type { AiTool } from "../../../repo/repo_service.ts";
import type { CheckContext } from "../check.ts";
import { makeBinaryOnPathCheck } from "./binary_on_path.ts";

function makeCtx(tool: AiTool): CheckContext {
  return {
    repoPath: "/tmp/repo",
    auditDir: "/tmp/repo/.swamp/audit",
    tool,
    abortSignal: new AbortController().signal,
    spawnSwamp: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

Deno.test("binaryOnPath: passes when `which` returns a path", async () => {
  const check = makeBinaryOnPathCheck({
    resolveBinary: (name) => Promise.resolve(`/usr/local/bin/${name}`),
  });
  const result = await check.run(makeCtx("kiro"));
  assertEquals(result.status, "pass");
  assertEquals(result.name, "binary-on-path");
  assertStringIncludes(result.message, "kiro-cli");
  assertStringIncludes(result.message, "/usr/local/bin/kiro-cli");
});

Deno.test("binaryOnPath: fails with install hint when binary is not found", async () => {
  const check = makeBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve(null),
  });
  const result = await check.run(makeCtx("claude"));
  assertEquals(result.status, "fail");
  assertStringIncludes(result.message, "not on PATH");
  assertStringIncludes(result.hint ?? "", "Install Claude Code");
});

Deno.test("binaryOnPath: uses tool-specific binary name", async () => {
  const seen: string[] = [];
  const check = makeBinaryOnPathCheck({
    resolveBinary: (name) => {
      seen.push(name);
      return Promise.resolve(null);
    },
  });
  await check.run(makeCtx("kiro"));
  await check.run(makeCtx("claude"));
  await check.run(makeCtx("cursor"));
  await check.run(makeCtx("opencode"));
  assertEquals(seen, ["kiro-cli", "claude", "cursor", "opencode"]);
});

Deno.test("binaryOnPath: appliesTo returns true for all four audit tools, false otherwise", () => {
  const check = makeBinaryOnPathCheck({
    resolveBinary: () => Promise.resolve(null),
  });
  assertEquals(check.appliesTo("claude"), true);
  assertEquals(check.appliesTo("cursor"), true);
  assertEquals(check.appliesTo("kiro"), true);
  assertEquals(check.appliesTo("opencode"), true);
  assertEquals(check.appliesTo("codex"), false);
  assertEquals(check.appliesTo("copilot"), false);
  assertEquals(check.appliesTo("none"), false);
});
