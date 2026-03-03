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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { AuditService } from "../../domain/audit/audit_service.ts";
import { createBashCommandEntry } from "../../domain/audit/audit_command_entry.ts";
import { JsonlAuditRepository } from "../../infrastructure/persistence/jsonl_audit_repository.ts";
import {
  renderAuditTimeline,
  renderAuditToolNotSupported,
  renderNoAuditData,
} from "../../presentation/output/audit_output.ts";
import {
  type HookTool,
  normalizeHookInput,
} from "../../domain/audit/hook_input.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";

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
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options) {
    try {
      const tool = options.tool as HookTool;
      if (!VALID_HOOK_TOOLS.includes(tool)) {
        return;
      }

      const input = await readStdin();
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
        normalized.cwd || options.repoDir || ".",
        failure,
      );

      const repoDir = options.repoDir || ".";
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
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--hours <hours:number>", "Number of hours to analyze", {
    default: 24,
  })
  .option("--all", "Show all commands including noise (ls, cat, etc.)")
  .option("--session <id:string>", "Filter by session ID")
  .action(async function (options) {
    const ctx = createContext(options as GlobalOptions, ["audit"]);
    ctx.logger.debug`Fetching audit timeline`;

    const { repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    // Check if the configured tool supports audit hooks
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const configuredTool = marker?.tool ?? "claude";

    if (configuredTool === "codex") {
      renderAuditToolNotSupported("codex", ctx.outputMode);
    }

    const auditRepository = new JsonlAuditRepository(repoDir);
    const service = new AuditService(auditRepository);

    const timeline = await service.getTimeline({
      hours: options.hours,
      showAll: options.all ?? false,
      sessionId: options.session,
    });

    if (
      timeline.entries.length === 0 && timeline.totalSwamp === 0 &&
      timeline.totalDirect === 0
    ) {
      renderNoAuditData(ctx.outputMode);
      return;
    }

    renderAuditTimeline(timeline, ctx.outputMode);
    ctx.logger.debug("Audit command completed");
  })
  .command("record", auditRecordCommand);
