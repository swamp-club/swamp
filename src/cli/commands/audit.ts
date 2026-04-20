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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { AuditService } from "../../domain/audit/audit_service.ts";
import { createBashCommandEntry } from "../../domain/audit/audit_command_entry.ts";
import { JsonlAuditRepository } from "../../infrastructure/persistence/jsonl_audit_repository.ts";
import {
  type HookTool,
  normalizeHookInput,
} from "../../domain/audit/hook_input.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  auditTimeline,
  consumeStream,
  createAuditTimelineDeps,
  createLibSwampContext,
} from "../../libswamp/mod.ts";
import { createAuditTimelineRenderer } from "../../presentation/renderers/audit_timeline.ts";

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

/** Valid values for the --tool option */
const VALID_HOOK_TOOLS: HookTool[] = ["claude", "cursor", "kiro", "opencode"];

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

      const repoDir = resolveRepoDir(options.repoDir as string | undefined);
      const repository = new JsonlAuditRepository(repoDir);
      await repository.append(entry);

      // Fire-and-forget cleanup of old audit data
      const service = new AuditService(repository);
      service.cleanupOldAuditData();
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
export const auditCommand = new Command()
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
  .action(async function (options) {
    const ctx = createContext(options as GlobalOptions, ["audit"]);
    ctx.logger.debug`Fetching audit timeline`;

    const { repoDir } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    // Check if the configured tool supports audit hooks
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const configuredTool = marker?.tool ?? "claude";

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createAuditTimelineDeps(repoDir);
    const renderer = createAuditTimelineRenderer(ctx.outputMode);
    await consumeStream(
      auditTimeline(libCtx, deps, {
        hours: options.hours,
        showAll: options.all ?? false,
        sessionId: options.session,
        tool: configuredTool,
      }),
      renderer.handlers(),
    );

    ctx.logger.debug("Audit command completed");
  })
  .command("record", auditRecordCommand);
