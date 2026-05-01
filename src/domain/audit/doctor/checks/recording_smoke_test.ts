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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { AiTool } from "../../../repo/repo_service.ts";
import { todaysAuditFilePath } from "../../audit_path.ts";
import type { CheckContext, SpawnFn } from "../check.ts";
import { recordingSmokeTestCheck } from "./recording_smoke.ts";

async function withTempAuditDir<T>(
  fn: (auditDir: string) => Promise<T>,
): Promise<T> {
  const repo = await Deno.makeTempDir({ prefix: "doctor-smoke-test-" });
  const auditDir = join(repo, ".swamp", "audit");
  try {
    return await fn(auditDir);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
}

function makeCtx(
  auditDir: string,
  tool: AiTool,
  spawnSwamp: SpawnFn,
): CheckContext {
  return {
    repoPath: auditDir.replace(/\.swamp\/audit$/, ""),
    auditDir,
    tool,
    abortSignal: new AbortController().signal,
    spawnSwamp,
  };
}

/**
 * A fake SpawnFn that simulates `swamp audit record --from-hook` by
 * extracting the command from the stdin payload and writing a matching
 * audit row. Simulates the successful-hook case.
 */
function makeFakeSpawnThatWritesRow(auditDir: string): SpawnFn {
  return async (_args, stdin) => {
    const raw = JSON.parse(stdin) as {
      tool_input?: { command?: string };
      toolArgs?: { command?: string };
      session_id?: string;
    };
    const command = raw.tool_input?.command ?? raw.toolArgs?.command ?? "";
    const entry = {
      timestamp: new Date().toISOString(),
      command,
      cwd: ".",
      ...(raw.session_id ? { sessionId: raw.session_id } : {}),
    };
    await ensureDir(auditDir);
    const path = todaysAuditFilePath(auditDir);
    await Deno.writeTextFile(path, JSON.stringify(entry) + "\n", {
      append: true,
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

/** A fake SpawnFn that no-ops, simulating a dropped hook payload. */
function makeFakeSpawnThatDropsRow(): SpawnFn {
  return () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
}

for (const tool of ["claude", "cursor", "kiro", "opencode"] as const) {
  Deno.test(
    `recordingSmokeTest(${tool}): passes when the row lands`,
    async () => {
      await withTempAuditDir(async (auditDir) => {
        const result = await recordingSmokeTestCheck.run(
          makeCtx(auditDir, tool, makeFakeSpawnThatWritesRow(auditDir)),
        );
        assertEquals(result.status, "pass", JSON.stringify(result));
      });
    },
  );

  Deno.test(
    `recordingSmokeTest(${tool}): fails when the hook drops the row`,
    async () => {
      await withTempAuditDir(async (auditDir) => {
        const result = await recordingSmokeTestCheck.run(
          makeCtx(auditDir, tool, makeFakeSpawnThatDropsRow()),
        );
        assertEquals(result.status, "fail", JSON.stringify(result));
        assertStringIncludes(result.message, "did NOT land");
        assertStringIncludes(result.hint ?? "", "hook_input.ts");
      });
    },
  );
}

Deno.test("recordingSmokeTest: fails cleanly when spawn throws", async () => {
  await withTempAuditDir(async (auditDir) => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error("fake spawn failure");
    };
    const result = await recordingSmokeTestCheck.run(
      makeCtx(auditDir, "claude", throwingSpawn),
    );
    assertEquals(result.status, "fail");
    assertStringIncludes(result.message, "fake spawn failure");
  });
});

Deno.test("recordingSmokeTest: appliesTo returns true only for audit-hook tools", () => {
  assertEquals(recordingSmokeTestCheck.appliesTo("claude"), true);
  assertEquals(recordingSmokeTestCheck.appliesTo("kiro"), true);
  assertEquals(recordingSmokeTestCheck.appliesTo("codex"), false);
  assertEquals(recordingSmokeTestCheck.appliesTo("copilot"), false);
  assertEquals(recordingSmokeTestCheck.appliesTo("none"), false);
});

Deno.test(
  "recordingSmokeTest: passes the abort signal through to spawnSwamp",
  async () => {
    await withTempAuditDir(async (auditDir) => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const captureSpawn: SpawnFn = (_args, stdin, _env, signal) => {
        receivedSignal = signal;
        // Simulate a hook that drops the row, so the run still completes.
        return makeFakeSpawnThatDropsRow()(_args, stdin);
      };
      const ctx: CheckContext = {
        repoPath: auditDir.replace(/\.swamp\/audit$/, ""),
        auditDir,
        tool: "claude",
        abortSignal: controller.signal,
        spawnSwamp: captureSpawn,
      };
      await recordingSmokeTestCheck.run(ctx);
      assertEquals(receivedSignal, controller.signal);
    });
  },
);

Deno.test(
  "recordingSmokeTest: returns actionable fail when audit dir is not writable",
  // Permission semantics differ on Windows; chmod 0500 is not enforced there.
  { ignore: Deno.build.os === "windows" },
  async () => {
    const repo = await Deno.makeTempDir({ prefix: "doctor-smoke-readonly-" });
    const auditDir = join(repo, ".swamp", "audit-locked");
    await ensureDir(auditDir);
    await Deno.chmod(auditDir, 0o500);
    try {
      // Force a child path inside the readonly dir so ensureDir must mkdir.
      const childAuditDir = join(auditDir, "today");
      const result = await recordingSmokeTestCheck.run(
        makeCtx(childAuditDir, "claude", makeFakeSpawnThatDropsRow()),
      );
      assertEquals(result.status, "fail");
      assertStringIncludes(result.message, "not writable");
      assertStringIncludes(result.hint ?? "", "chmod");
    } finally {
      await Deno.chmod(auditDir, 0o700).catch(() => {});
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    }
  },
);
