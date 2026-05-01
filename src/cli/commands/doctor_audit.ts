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

import { Command } from "@cliffy/command";
import {
  auditDoctor,
  consumeStream,
  NoToolConfiguredError,
  type SpawnFn,
} from "../../libswamp/mod.ts";
import type { AiTool } from "../../infrastructure/persistence/repo_marker_repository.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { defaultCommandResolver } from "../../infrastructure/process/resolve_command.ts";
import { createAuditDoctorRenderer } from "../../presentation/renderers/audit_doctor.ts";
import { parseAiToolOrThrow } from "../ai_tool_parser.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";

/**
 * Resolves the target AI tool for `doctor audit`. Priority: explicit
 * `--tool` flag (after validation), then `.swamp.yaml`'s `tool` field.
 * If neither is present, throws `NoToolConfiguredError`.
 *
 * Exported for testing.
 */
export function resolveTargetTool(
  flagTool: string | undefined,
  markerTool: AiTool | undefined,
): AiTool {
  const overrideTool = flagTool ? parseAiToolOrThrow(flagTool) : undefined;
  const resolved = overrideTool ?? markerTool;
  if (!resolved) {
    throw new NoToolConfiguredError();
  }
  return resolved;
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Builds a SpawnFn that invokes the currently-running swamp binary against
 * the supplied repo directory. Pins `--repo-dir` on every call so the
 * spawned `audit record` writes into the same repo being audited, not
 * whatever repo the CWD happens to point at.
 */
function makeSwampSpawnFn(repoDir: string): SpawnFn {
  const execPath = Deno.execPath();
  // When running from source (`deno run dev ...`), Deno.execPath() returns
  // the deno binary and Deno.mainModule points at the swamp entrypoint. When
  // running the compiled binary, Deno.execPath() is the compiled swamp and
  // we invoke it directly.
  const runningFromSource = /\/deno(\.exe)?$/.test(execPath);
  return async (args, stdin, env = {}) => {
    const argsWithRepo = [...args, "--repo-dir", repoDir];
    const fullArgs = runningFromSource
      ? ["run", "-A", Deno.mainModule, ...argsWithRepo]
      : argsWithRepo;
    const cmd = new Deno.Command(execPath, {
      args: fullArgs,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), ...env },
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(stdin));
    } finally {
      await writer.close();
    }
    const { code, stdout, stderr } = await child.output();
    const decoder = new TextDecoder();
    return {
      exitCode: code,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  };
}

/**
 * `swamp doctor audit` — runs preflight checks against the AI-tool audit
 * integration configured in `.swamp.yaml` (or the tool supplied via
 * `--tool`) and reports per-check pass/fail/skip with actionable hints.
 *
 * Exits non-zero on any check fail so CI can gate on audit integration
 * health.
 */
export const doctorAuditCommand = new Command()
  .description(
    "Verify that the AI-tool audit integration is healthy for the configured tool.",
  )
  .example("Check the tool configured in .swamp.yaml", "swamp doctor audit")
  .example("Check a specific tool", "swamp doctor audit --tool kiro")
  .example("Machine-readable output for CI", "swamp doctor audit --json")
  .option(
    "--tool <tool:string>",
    "Override the tool from .swamp.yaml (claude | cursor | kiro | opencode | codex | copilot | none)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["doctor", "audit"]);
    cliCtx.logger.debug("Executing doctor audit command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { marker } = await resolveDatastoreForRepo(repoDir);
    // Pass the primary enrolled tool (or undefined when no tools are
    // enrolled) so resolveTargetTool throws NoToolConfiguredError only
    // when neither the flag nor the marker provides a tool.
    const resolvedTool = resolveTargetTool(
      options.tool as string | undefined,
      marker?.tools?.[0],
    );

    const auditDir = swampPath(repoDir, SWAMP_SUBDIRS.audit);
    const controller = new AbortController();
    const renderer = createAuditDoctorRenderer(cliCtx.outputMode);

    const commandResolver = defaultCommandResolver();
    await consumeStream(
      auditDoctor({
        repoPath: repoDir,
        auditDir,
        tool: resolvedTool,
        spawnSwamp: makeSwampSpawnFn(repoDir),
        abortSignal: controller.signal,
        resolveBinary: (name) => commandResolver.resolve(name),
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor audit command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  });
