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
import { isAbsolute, join, resolve } from "@std/path";
import {
  createContext,
  findAncestorRepoDir,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { AuditTimelineResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;
import { AuditService } from "../../domain/audit/audit_service.ts";
import {
  type BashCommandEntry,
  createBashCommandEntry,
} from "../../domain/audit/audit_command_entry.ts";
import { JsonlAuditRepository } from "../../infrastructure/persistence/jsonl_audit_repository.ts";
import { SWAMP_MARKER_FILE } from "../../infrastructure/persistence/paths.ts";
import {
  type HookTool,
  normalizeHookInput,
} from "../../domain/audit/hook_input.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  auditTimeline,
  type AuditTimelineData,
  consumeStream,
  createAuditTimelineDeps,
  createLibSwampContext,
} from "../../libswamp/mod.ts";
import { createAuditTimelineRenderer } from "../../presentation/renderers/audit_timeline.ts";
import { auditAlertsCommand } from "./audit_alerts.ts";
import { auditExportCommand } from "./audit_export.ts";
import { auditLogCommand } from "./audit_log.ts";
import { auditReportCommand } from "./audit_report.ts";
import { auditRotateKeyCommand } from "./audit_rotate_key.ts";
import { auditVerifyCommand } from "./audit_verify.ts";

/**
 * Reads all of stdin as a string.
 */
async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for await (const chunk of Deno.stdin.readable) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  return chunks.join("");
}

/**
 * Reads hook input for the given tool.
 *
 * Kiro IDE passes postToolUse data via the USER_PROMPT environment variable
 * rather than stdin. We check USER_PROMPT first for kiro, falling back to
 * stdin for kiro-cli compatibility. All other tools read from stdin.
 */
function readHookInput(tool: HookTool): Promise<string> {
  if (tool === "kiro") {
    const envInput = Deno.env.get("USER_PROMPT");
    if (envInput) return Promise.resolve(envInput);
  }
  return readStdin();
}

/**
 * Where a hook invocation came from, used to pick the repository its audit
 * row belongs to. Environment and process state are passed in rather than
 * read here so resolution stays deterministic under test.
 */
export interface AuditHookTarget {
  /** The `--repo-dir` option on the hook command, if any. */
  explicitRepoDir?: string;
  /** The `cwd` field from the hook payload (may be empty or relative). */
  hookCwd?: string;
  /** The value of `SWAMP_REPO_DIR`, if set. */
  envRepoDir?: string;
  /** The hook process's working directory. */
  processCwd: string;
  /** Finds the nearest initialized repo at or above a directory. */
  findRepo?: (startDir: string) => string | null;
}

function hasRepoMarker(dir: string): boolean {
  try {
    return Deno.statSync(join(dir, SWAMP_MARKER_FILE)).isFile;
  } catch {
    return false;
  }
}

/**
 * Resolves the initialized swamp repository an audit hook row belongs to.
 *
 * An explicit `--repo-dir` is used as given, like every other command: if it
 * is not an initialized repo the result is `null`. Otherwise these are tried in
 * order: the hook payload cwd walked up to the nearest `.swamp.yaml`,
 * `SWAMP_REPO_DIR`, then the process cwd walked up the same way. Returns
 * `null` when none of them is an initialized repo, so the hook never creates a
 * `.swamp/` directory outside a repository.
 *
 * @internal Exported for testing
 */
export function resolveAuditRepoDir(target: AuditHookTarget): string | null {
  const findRepo = target.findRepo ?? findAncestorRepoDir;

  if (target.explicitRepoDir !== undefined) {
    const dir = resolve(target.explicitRepoDir);
    return hasRepoMarker(dir) ? dir : null;
  }

  if (target.hookCwd && isAbsolute(target.hookCwd)) {
    // Check the cwd itself first: the ancestor walk spawns git, and the
    // agent usually runs from the repo root.
    if (hasRepoMarker(target.hookCwd)) return resolve(target.hookCwd);
    const dir = findRepo(target.hookCwd);
    if (dir !== null) return dir;
  }

  if (target.envRepoDir) {
    const dir = resolve(target.envRepoDir);
    if (hasRepoMarker(dir)) return dir;
  }

  return findRepo(target.processCwd);
}

/**
 * Appends a hook's bash command entry to the audit log of the repository
 * {@link resolveAuditRepoDir} picks. Writes nothing when no initialized
 * repository is found.
 *
 * @param options.cleanup Start old-data cleanup after the append (default
 *   `true`). Tests pass `false` so no unawaited directory scan outlives them.
 * @returns Whether the entry was recorded.
 * @internal Exported for testing
 */
export async function recordHookEntry(
  entry: BashCommandEntry,
  target: AuditHookTarget,
  options: { cleanup?: boolean } = {},
): Promise<boolean> {
  const repoDir = resolveAuditRepoDir(target);
  if (repoDir === null) {
    return false;
  }

  const repository = new JsonlAuditRepository(repoDir);
  await repository.append(entry);

  if (options.cleanup ?? true) {
    // Fire-and-forget cleanup of old audit data
    const service = new AuditService(repository);
    service.cleanupOldAuditData();
  }
  return true;
}

/** Valid values for the --tool option */
const VALID_HOOK_TOOLS: HookTool[] = [
  "claude",
  "cursor",
  "kiro",
  "opencode",
  "copilot",
  "pi",
  "antigravity",
];

/**
 * `swamp audit record --from-hook`
 *
 * Reads hook JSON from stdin and appends to the audit log.
 * Must never throw - this runs as a PostToolUse/PostToolUseFailure hook
 * and errors would disrupt the user's workflow.
 */
export const auditRecordCommand = new Command()
  .name("record")
  .description("Record a bash command from a hook")
  .option("--from-hook", "Required: indicates input comes from a hook", {
    required: true,
  })
  .option("--tool <tool:string>", "AI tool providing hook input", {
    default: "claude",
  })
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options) {
    try {
      const tool = options.tool as HookTool;
      if (!VALID_HOOK_TOOLS.includes(tool)) {
        return;
      }

      const input = await readHookInput(tool);
      if (!input.trim()) {
        return;
      }

      const raw = JSON.parse(input) as Record<string, unknown>;
      const normalized = normalizeHookInput(tool, raw);

      // Skip non-shell tool invocations
      if (!normalized) {
        return;
      }

      const failure = normalized.isFailure
        ? {
          exitCode: normalized.exitCode,
          error: normalized.errorMessage,
        }
        : undefined;

      const entry = createBashCommandEntry(
        normalized.sessionId,
        normalized.command,
        normalized.cwd || resolveRepoDir(options.repoDir as string | undefined),
        failure,
      );

      await recordHookEntry(entry, {
        explicitRepoDir: options.repoDir as string | undefined,
        hookCwd: normalized.cwd,
        envRepoDir: Deno.env.get("SWAMP_REPO_DIR"),
        processCwd: Deno.cwd(),
      });
    } catch {
      // Must never throw - this is a hook command.
      // Errors would disrupt the user's coding session.
    }
  });

/**
 * `swamp audit`
 *
 * View a merged timeline of swamp operations vs direct CLI commands.
 * Also serves as the parent command for `swamp audit record`.
 */
export const auditCommand = withRemoteOptions(
  new Command()
    .name("audit")
    .description("View audit timeline of swamp vs direct CLI commands")
    .example("View audit timeline", "swamp audit")
    .example("Last 4 hours", "swamp audit --hours 4")
    .example("Include all commands", "swamp audit --all")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--hours <hours:number>", "Number of hours to analyze", {
      default: 24,
    })
    .option("--all", "Show all commands including noise (ls, cat, etc.)")
    .option("--session <id:string>", "Filter by session ID")
    .option(
      "--include-diagnostic",
      "Include rows written by `swamp doctor audit`'s smoke test (filtered by default)",
    ),
).action(async function (options: AnyOptions) {
  const ctx = createContext(options as GlobalOptions, ["audit"]);
  ctx.logger.debug`Fetching audit timeline`;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<AuditTimelineResponse>(
      { server, token },
      {
        type: "audit.timeline",
        payload: {
          hours: options.hours,
          showAll: options.all ?? false,
          sessionId: options.session,
          includeDiagnostic: options.includeDiagnostic ?? false,
        },
      },
    );
    const renderer = createAuditTimelineRenderer(ctx.outputMode);
    renderer.handlers().completed({
      kind: "completed",
      data: response.data as unknown as AuditTimelineData,
    });
    return;
  }

  const { repoDir } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: ctx.outputMode,
  });

  // Check if the configured tool supports audit hooks
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));
  const configuredTool = resolvePrimaryTool(marker);

  const libCtx = createLibSwampContext({ logger: ctx.logger });
  const deps = createAuditTimelineDeps(repoDir);
  const renderer = createAuditTimelineRenderer(ctx.outputMode);
  await consumeStream(
    auditTimeline(libCtx, deps, {
      hours: options.hours,
      showAll: options.all ?? false,
      sessionId: options.session,
      tool: configuredTool,
      includeDiagnostic: options.includeDiagnostic ?? false,
    }),
    renderer.handlers(),
  );

  ctx.logger.debug("Audit command completed");
}).command("record", auditRecordCommand)
  .command("alerts", auditAlertsCommand)
  .command("export", auditExportCommand)
  .command("log", auditLogCommand)
  .command("report", auditReportCommand)
  .command("rotate-key", auditRotateKeyCommand)
  .command("verify", auditVerifyCommand);
