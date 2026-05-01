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

import { join } from "@std/path";
import type { AiTool } from "../../../repo/repo_service.ts";
import type { CheckContext, CheckResult, PreflightCheck } from "../check.ts";
import type { ResolveBinary } from "./resolve_binary.ts";

/**
 * Verifies swamp itself is invocable from the hook. All four supported
 * tools embed the string `swamp audit record --from-hook` in their hook
 * configs and rely on PATH lookup at hook-fire time; without swamp on
 * PATH, every hook silently fails on every tool.
 *
 * For Kiro only, the init command also bakes an absolute swamp path into
 * `.kiro/hooks/swamp-audit.kiro.hook` (kiro-cli doesn't do PATH lookup).
 * A later `brew upgrade` or path change can orphan that baked reference.
 * This check surfaces both conditions.
 */

function appliesTo(tool: AiTool): boolean {
  return tool === "claude" || tool === "cursor" || tool === "kiro" ||
    tool === "opencode";
}

async function checkKiroBakedPath(ctx: CheckContext): Promise<{
  ok: boolean;
  bakedPath?: string;
  message?: string;
}> {
  const hookPath = join(ctx.repoPath, ".kiro/hooks/swamp-audit.kiro.hook");
  try {
    const content = await Deno.readTextFile(hookPath);
    const parsed = JSON.parse(content) as {
      then?: { command?: string };
    };
    const command = parsed.then?.command;
    if (!command) {
      return { ok: false, message: "kiro hook has no `then.command`" };
    }
    // Command format is `"<absolute-swamp-path>" audit record --from-hook --tool kiro`
    const match = command.match(/^"([^"]+)"/);
    const bakedPath = match?.[1];
    if (!bakedPath) {
      return {
        ok: false,
        message:
          `could not extract absolute path from kiro hook command: ${command}`,
      };
    }
    try {
      const stat = await Deno.stat(bakedPath);
      if (!stat.isFile) {
        return {
          ok: false,
          bakedPath,
          message: `kiro hook's baked path ${bakedPath} is not a file`,
        };
      }
      return { ok: true, bakedPath };
    } catch {
      return {
        ok: false,
        bakedPath,
        message: `kiro hook's baked path ${bakedPath} does not exist`,
      };
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: false, message: `${hookPath} is missing` };
    }
    throw error;
  }
}

/**
 * `resolveBinary` is injected — domain owns the port, the CLI passes in
 * `defaultCommandResolver()` from `infrastructure/process` at wiring time.
 */
export function makeSwampBinaryOnPathCheck(
  opts: { resolveBinary: ResolveBinary },
): PreflightCheck {
  const { resolveBinary } = opts;
  return {
    name: "swamp-binary-on-path",
    description:
      "swamp binary is invokable from the hook (PATH lookup; Kiro also checks the baked absolute path)",
    appliesTo,
    async run(ctx): Promise<CheckResult> {
      const pathResolved = await resolveBinary("swamp");
      if (!pathResolved) {
        return {
          name: "swamp-binary-on-path",
          status: "fail",
          message: "swamp is not on PATH",
          hint:
            "The audit hooks invoke `swamp audit record` — without swamp on PATH, every hook silently fails. Install swamp or add it to PATH.",
        };
      }

      if (ctx.tool === "kiro") {
        const baked = await checkKiroBakedPath(ctx);
        if (!baked.ok) {
          return {
            name: "swamp-binary-on-path",
            status: "fail",
            message: baked.message ?? "kiro baked swamp path is not usable",
            hint:
              "Run `swamp init --tool kiro --force` to re-bake the absolute swamp path into the hook file.",
            details: { pathResolved, bakedPath: baked.bakedPath },
          };
        }
        return {
          name: "swamp-binary-on-path",
          status: "pass",
          message:
            `swamp is on PATH at ${pathResolved}; kiro hook points at ${baked.bakedPath}`,
          details: { pathResolved, bakedPath: baked.bakedPath },
        };
      }

      return {
        name: "swamp-binary-on-path",
        status: "pass",
        message: `swamp is on PATH at ${pathResolved}`,
        details: { pathResolved },
      };
    },
  };
}
