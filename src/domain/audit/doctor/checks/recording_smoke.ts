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

import { ensureDir } from "@std/fs";
import type { AiTool } from "../../../repo/repo_service.ts";
import { todaysAuditFilePath } from "../../audit_path.ts";
import type { PreflightCheck } from "../check.ts";
import { syntheticPayloadFor } from "../synthetic_payloads.ts";

/**
 * End-to-end smoke test: pipes a synthetic hook payload through
 * `swamp audit record --from-hook --tool <tool>` and verifies a new row
 * with the fixture's sentinel command string lands in today's JSONL.
 *
 * This is the check that would have caught the kiro-cli 2.0 runtime
 * contract change (the `execute_bash`→`shell` drift cited in the issue).
 *
 * Never relies on subprocess exit code — `audit record --from-hook` never
 * throws by design (to avoid disrupting the user's coding session).
 */

function appliesTo(tool: AiTool): boolean {
  return tool === "claude" || tool === "cursor" || tool === "kiro" ||
    tool === "opencode";
}

function randomNonce(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function readAuditRowsFromToday(auditDir: string): Promise<string[]> {
  const path = todaysAuditFilePath(auditDir);
  try {
    const content = await Deno.readTextFile(path);
    return content.split("\n").filter((line) => line.trim());
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

export const recordingSmokeTestCheck: PreflightCheck = {
  name: "recording-smoke-test",
  description:
    "Synthetic hook payload round-trips through `swamp audit record` and lands in the audit log",
  appliesTo,
  async run(ctx) {
    const payload = syntheticPayloadFor(ctx.tool, randomNonce());
    if (!payload) {
      return {
        name: "recording-smoke-test",
        status: "skip",
        message: `tool ${ctx.tool} has no audit hook payload shape`,
      };
    }

    try {
      await ensureDir(ctx.auditDir);
    } catch (error) {
      if (error instanceof Deno.errors.PermissionDenied) {
        return {
          name: "recording-smoke-test",
          status: "fail",
          message: `audit directory is not writable: ${ctx.auditDir}`,
          hint:
            `The audit directory exists but the current user cannot write to it. Check ownership and permissions (e.g. \`ls -ld ${ctx.auditDir}\`) and \`chmod\`/\`chown\` it so the user running swamp can write to it.`,
          details: { auditDir: ctx.auditDir, error: String(error) },
        };
      }
      throw error;
    }

    try {
      await ctx.spawnSwamp(
        ["audit", "record", "--from-hook", "--tool", ctx.tool],
        payload.stdin,
        payload.env,
        ctx.abortSignal,
      );
    } catch (error) {
      return {
        name: "recording-smoke-test",
        status: "fail",
        message: `failed to spawn swamp: ${error}`,
        hint:
          "The swamp binary spawn failed. Verify swamp is installed and executable.",
        details: { error: String(error) },
      };
    }

    const rows = await readAuditRowsFromToday(ctx.auditDir);
    const found = rows.some((line) => {
      try {
        const entry = JSON.parse(line) as { command?: string };
        return entry.command === payload.expectedCommand;
      } catch {
        return false;
      }
    });

    if (found) {
      return {
        name: "recording-smoke-test",
        status: "pass",
        message: `synthetic ${ctx.tool} payload landed in today's audit JSONL`,
      };
    }

    return {
      name: "recording-smoke-test",
      status: "fail",
      message:
        `synthetic ${ctx.tool} payload did NOT land in today's audit JSONL`,
      hint:
        `The hook normalizer in src/domain/audit/hook_input.ts may have drifted from the upstream contract in src/domain/audit/doctor/synthetic_payloads.ts. Compare the two and update one to match the other, or file an issue.`,
      details: { expectedCommand: payload.expectedCommand, tool: ctx.tool },
    };
  },
};
