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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { UserError } from "../../domain/errors.ts";
import {
  claudeUserConfigDir,
  installClaudeUserAuditHook,
  removeClaudeUserAuditHook,
  type UserAuditHookResult,
} from "../../domain/audit/user_hook.ts";
import { homeDirectory } from "../../infrastructure/persistence/paths.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface AuditUserHookData {
  readonly action: "install" | "uninstall";
  readonly scope: "user";
  readonly tool: "claude";
  readonly settingsPath: string;
  readonly changed: boolean;
}

export type AuditUserHookEvent =
  | { kind: "completed"; data: AuditUserHookData }
  | { kind: "error"; error: SwampError };

export interface AuditUserHookDeps {
  claudeDir(): string;
  install(claudeDir: string): Promise<UserAuditHookResult>;
  remove(claudeDir: string): Promise<UserAuditHookResult>;
}

export function resolveClaudeUserConfigDir(): string {
  const envConfigDir = Deno.env.get("CLAUDE_CONFIG_DIR");
  if (envConfigDir) return claudeUserConfigDir("", envConfigDir);
  try {
    return claudeUserConfigDir(homeDirectory(), undefined);
  } catch {
    throw new UserError(
      "Cannot find your Claude Code settings: set HOME (USERPROFILE on Windows) or CLAUDE_CONFIG_DIR.",
    );
  }
}

export function createAuditUserHookDeps(): AuditUserHookDeps {
  return {
    claudeDir: resolveClaudeUserConfigDir,
    install: installClaudeUserAuditHook,
    remove: removeClaudeUserAuditHook,
  };
}

function userHookEvents(
  action: AuditUserHookData["action"],
  ctx: LibSwampContext,
  deps: AuditUserHookDeps,
): AsyncIterable<AuditUserHookEvent> {
  return withGeneratorSpan(
    `swamp.audit.${action}`,
    {},
    (async function* () {
      try {
        const claudeDir = deps.claudeDir();
        const result = action === "install"
          ? await deps.install(claudeDir)
          : await deps.remove(claudeDir);
        ctx.logger.debug`Audit hook ${action} at ${result.settingsPath}`;
        yield {
          kind: "completed" as const,
          data: {
            action,
            scope: "user" as const,
            tool: "claude" as const,
            ...result,
          },
        };
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        yield {
          kind: "error" as const,
          error: {
            code: error.code ?? "user_error",
            message: error.message,
            cause: error,
          },
        };
      }
    })(),
  );
}

export async function* auditInstall(
  ctx: LibSwampContext,
  deps: AuditUserHookDeps,
): AsyncIterable<AuditUserHookEvent> {
  yield* userHookEvents("install", ctx, deps);
}

export async function* auditUninstall(
  ctx: LibSwampContext,
  deps: AuditUserHookDeps,
): AsyncIterable<AuditUserHookEvent> {
  yield* userHookEvents("uninstall", ctx, deps);
}
