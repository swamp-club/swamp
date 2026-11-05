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
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  auditInstall,
  auditUninstall,
  type AuditUserHookDeps,
  createAuditUserHookDeps,
} from "../../libswamp/audit/install.ts";
import { createAuditUserHookHandlers } from "../../presentation/renderers/audit_install.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** --user is the only scope; the repo-level hook belongs to repo upgrade */
export function requireUserScope(action: string, user: unknown): void {
  if (user === true) return;
  throw new UserError(
    `swamp audit ${action} needs --user: it manages the hook in your Claude Code user settings. ` +
      "The hook in a repo's .claude/settings.local.json is managed by `swamp repo upgrade`.",
    "usage_error",
  );
}

export async function runAuditUserHook(
  action: "install" | "uninstall",
  options: AnyOptions,
  deps: AuditUserHookDeps = createAuditUserHookDeps(),
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, ["audit", action]);
  requireUserScope(action, options.user);
  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  await consumeStream(
    action === "install" ? auditInstall(ctx, deps) : auditUninstall(ctx, deps),
    createAuditUserHookHandlers(cliCtx.outputMode),
  );
}

export const auditInstallCommand = new Command()
  .name("install")
  .description(
    "Add swamp's audit hook to your Claude Code user settings (~/.claude/settings.json,\n" +
      "or settings.json in CLAUDE_CONFIG_DIR) so Bash and PowerShell calls whose working\n" +
      "directory is inside a swamp repo are recorded, even when the session started\n" +
      "above the repo. The hook runs swamp on every such call in every project; calls\n" +
      "run from outside a swamp repo are not recorded.",
  )
  .option("--user", "Install into your Claude Code user settings (required)")
  .example("Install the user-level hook", "swamp audit install --user")
  .action(async function (options: AnyOptions) {
    await runAuditUserHook("install", options);
  });

export const auditUninstallCommand = new Command()
  .name("uninstall")
  .description(
    "Remove the audit hook entries swamp added to your Claude Code user settings.\n" +
      "Hooks you wrote or changed yourself are left in place.",
  )
  .option("--user", "Remove from your Claude Code user settings (required)")
  .example("Remove the user-level hook", "swamp audit uninstall --user")
  .action(async function (options: AnyOptions) {
    await runAuditUserHook("uninstall", options);
  });
