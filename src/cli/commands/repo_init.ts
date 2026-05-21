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

import { Command, EnumType } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  createRepoInitDeps,
  createRepoUpgradeDeps,
  repoInit,
  repoUpgrade,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createRepoInitRenderer,
  createRepoUpgradeRenderer,
} from "../../presentation/renderers/repo_init.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { createExtensionInstallDeps } from "../create_extension_install_deps.ts";
import { VERSION } from "./version.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const aiToolType = new EnumType([
  "claude",
  "cursor",
  "opencode",
  "codex",
  "copilot",
  "kiro",
  "none",
]);

/**
 * Resolves a Cliffy `--tool` collect array into the `tools` list passed
 * downstream. Returns `undefined` when the user did not pass `--tool` at all
 * — the caller layer (RepoService.init defaults to ["claude"];
 * RepoService.upgrade preserves marker.tools). Validates `none + other`
 * combinations and dedupes repeated values.
 *
 * Exported for unit testing.
 */
export function resolveToolFlag(toolOption: unknown): string[] | undefined {
  if (toolOption === undefined) return undefined;
  const raw = Array.isArray(toolOption) ? toolOption as string[] : [];
  if (raw.length === 0) return undefined;

  const hasNone = raw.includes("none");
  if (hasNone && raw.length > 1) {
    throw new UserError(
      "Cannot combine --tool none with other --tool values. " +
        "Use --tool none alone to clear the enrolled tool list.",
    );
  }
  if (hasNone) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of raw) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

// Exported for reuse by repoCommand default action
export async function repoInitAction(
  options: AnyOptions,
  pathArg?: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, ["repo", "init"]);
  cliCtx.logger.debug`Initializing repository at: ${pathArg ?? "."}`;

  const tools = resolveToolFlag(options.tool);

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createRepoInitDeps(VERSION);
  const renderer = createRepoInitRenderer(cliCtx.outputMode);
  await consumeStream(
    repoInit(ctx, deps, {
      path: pathArg ?? ".",
      force: !!options.force,
      tools,
      version: VERSION,
    }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Repo init command completed");
}

const TOOL_FLAG_DESCRIPTION =
  "AI coding tool to configure for. Repeat to enroll multiple tools " +
  "(e.g. `--tool claude --tool kiro`). Duplicates are collapsed. " +
  "Use `--tool none` (alone) to skip tool scaffolding. Defaults to " +
  "`claude` when omitted. Valid values: claude, cursor, opencode, codex, " +
  "copilot, kiro, none.";

export const repoInitCommand = new Command()
  .description("Initialize a new swamp repository")
  .example("Initialize in current directory", "swamp repo init")
  .example("Initialize in a specific path", "swamp repo init ./my-project")
  .example(
    "Initialize for multiple AI tools",
    "swamp repo init --tool claude --tool kiro",
  )
  .example("Force reinitialize", "swamp repo init --force")
  .arguments("[path:string]")
  .option("-f, --force", "Reinitialize if already exists")
  .type("aiTool", aiToolType)
  .option("-t, --tool <tool:aiTool>", TOOL_FLAG_DESCRIPTION, { collect: true })
  .action(repoInitAction);

export const repoUpgradeCommand = new Command()
  .description("Upgrade an existing swamp repository")
  .example(
    "Upgrade preserving the enrolled tools",
    "swamp repo upgrade",
  )
  .example(
    "Replace the enrolled tool list",
    "swamp repo upgrade --tool claude --tool kiro",
  )
  .arguments("[path:string]")
  .type("aiTool", aiToolType)
  .option(
    "-t, --tool <tool:aiTool>",
    "Replace the enrolled tool list. Repeat to enroll multiple tools " +
      "(e.g. `--tool claude --tool kiro`). Omit to preserve the existing " +
      "list and just bump the swamp version. `--tool none` clears.",
    { collect: true },
  )
  .option("--include-gitignore", "Manage a swamp section in .gitignore")
  .action(async function (options: AnyOptions, pathArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["repo", "upgrade"]);
    cliCtx.logger.debug`Upgrading repository at: ${pathArg ?? "."}`;

    const tools = resolveToolFlag(options.tool);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createRepoUpgradeDeps(VERSION);

    // Build the extension install deps so the upgrade runs the install
    // pass afterward. This is what completes any legacy-layout
    // migration: `extensionInstall` detects entries at pre-current
    // layouts, re-pulls them into the per-extension subtree, and sweeps
    // the legacy files — a single command, no manual follow-up.
    const repoDir = resolveRepoDir(pathArg);
    const extensionInstallDeps = await createExtensionInstallDeps(
      repoDir,
      cliCtx.logger,
    );

    const renderer = createRepoUpgradeRenderer(cliCtx.outputMode);
    await consumeStream(
      repoUpgrade(ctx, deps, {
        path: pathArg ?? ".",
        tools,
        includeGitignore: options.includeGitignore as boolean | undefined,
        version: VERSION,
        extensionInstallDeps,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Repo upgrade command completed");
  });

export const repoCommand = new Command()
  .name("repo")
  .description("Manage swamp repositories")
  .action(function () {
    this.showHelp();
  })
  .command("init", repoInitCommand)
  .command("upgrade", repoUpgradeCommand);
