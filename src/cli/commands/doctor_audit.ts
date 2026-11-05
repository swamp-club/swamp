// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { auditDoctor } from "../../domain/audit/doctor/doctor_service.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { resolveClaudeUserConfigDir } from "../../libswamp/audit/install.ts";
import {
  NoToolConfiguredError,
  type SpawnFn,
} from "../../domain/audit/doctor/check.ts";

import {
  homeDirectory,
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { defaultCommandResolver } from "../../infrastructure/process/resolve_command.ts";
import { createAuditDoctorRenderer } from "../../presentation/renderers/audit_doctor.ts";
import { parseAiToolOrThrow, VALID_AI_TOOLS } from "../ai_tool_parser.ts";
import {
  createContext,
  getGitRootSync,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveServeUrl, withRemoteOptions } from "../remote_run.ts";

function userClaudeConfigDir(): string | undefined {
  try {
    return resolveClaudeUserConfigDir();
  } catch {
    return undefined;
  }
}

function userHomeDir(): string | undefined {
  try {
    return homeDirectory();
  } catch {
    return undefined;
  }
}

export function resolveTargetTool(
  flagTool: string | undefined,
  markerTool: string | undefined,
): string {
  const overrideTool = flagTool ? parseAiToolOrThrow(flagTool) : undefined;
  const resolved = overrideTool ?? markerTool;
  if (!resolved) {
    throw new NoToolConfiguredError(
      VALID_AI_TOOLS.filter((tool) => tool !== "none"),
    );
  }
  return resolved;
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const DEFAULT_SIGKILL_AFTER_MS = 3_000;

/**
 * on abort sends SIGTERM, since killing the doctor would reparent the child;
 * escalates to SIGKILL after sigkillAfterMs so a hung subprocess cannot keep
 * doctor alive.
 */
export async function runChildWithAbort(
  cmd: Deno.Command,
  stdin: string,
  signal: AbortSignal | undefined,
  opts: { sigkillAfterMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (signal?.aborted) {
    throw new DOMException("doctor audit aborted", "AbortError");
  }
  const sigkillAfterMs = opts.sigkillAfterMs ?? DEFAULT_SIGKILL_AFTER_MS;
  const child = cmd.spawn();
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child already exited; nothing to escalate.
      return;
    }
    escalationTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited between SIGTERM and the escalation tick.
      }
    }, sigkillAfterMs);
  };
  signal?.addEventListener("abort", onAbort);
  try {
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
  }
}

/**
 * pins --repo-dir so the spawned audit record writes into the audited repo, not
 * the CWD's; honours signal so SIGINT tears down the child.
 */
export function makeSwampSpawnFn(repoDir: string): SpawnFn {
  const execPath = Deno.execPath();
  // from source, Deno.execPath() is the deno binary and Deno.mainModule the
  // swamp entrypoint; the compiled binary is invoked directly.
  const runningFromSource = /\/deno(\.exe)?$/.test(execPath);
  return (args, stdin, env = {}, signal) => {
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
    return runChildWithAbort(cmd, stdin, signal);
  };
}

export const doctorAuditCommand = withRemoteOptions(
  new Command()
    .description(
      "Verify that the AI-tool audit integration is healthy for the configured tool.",
    )
    .example("Check the tool configured in .swamp.yaml", "swamp doctor audit")
    .example("Check a specific tool", "swamp doctor audit --tool kiro")
    .example("Machine-readable output for CI", "swamp doctor audit --json")
    .option(
      "--tool <tool:string>",
      `Override the tool from .swamp.yaml (${VALID_AI_TOOLS.join(" | ")})`,
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, ["doctor", "audit"]);
  cliCtx.logger.debug("Executing doctor audit command");

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    throw new UserError(
      "doctor audit is not supported with --server — it requires local process execution.",
    );
  }

  const repoDir = resolveRepoDir(options.repoDir);
  const { marker } = await resolveDatastoreForRepo(repoDir);
  // resolveTargetTool throws NoToolConfiguredError only when neither the flag
  // nor the marker provides a tool.
  const resolvedTool = resolveTargetTool(
    options.tool as string | undefined,
    marker?.tools?.[0],
  );

  const auditDir = swampPath(repoDir, SWAMP_SUBDIRS.audit);
  const controller = new AbortController();
  const renderer = createAuditDoctorRenderer(cliCtx.outputMode);

  // SIGINT tears down an in-flight smoke-test child; the listener is removed
  // after the first signal so a second Ctrl+C force-exits. SIGTERM is not
  // listened for: Deno does not support it on Windows.
  const onSigint = () => {
    try {
      Deno.removeSignalListener("SIGINT", onSigint);
    } catch {
      // Already removed (e.g. doctor finished before signal arrived).
    }
    controller.abort();
  };
  Deno.addSignalListener("SIGINT", onSigint);
  try {
    const commandResolver = defaultCommandResolver();
    await consumeStream(
      auditDoctor({
        repoPath: repoDir,
        auditDir,
        tool: resolvedTool,
        spawnSwamp: makeSwampSpawnFn(repoDir),
        abortSignal: controller.signal,
        resolveBinary: (name) => commandResolver.resolve(name),
        homeDir: userHomeDir(),
        claudeConfigDir: userClaudeConfigDir(),
        findGitRoot: getGitRootSync,
      }),
      renderer.handlers(),
    );
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSigint);
    } catch {
      // Listener may already be detached on a second signal.
    }
  }

  cliCtx.logger.debug("doctor audit command completed");

  if (renderer.overallStatus === "fail") {
    Deno.exit(1);
  }
});
